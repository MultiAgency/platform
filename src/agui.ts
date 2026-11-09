import type { ProgressRecord } from "./run-progress-schema.js";
import type { Tick } from "./evidence.js";
import { isTerminal } from "./operation-status.js";
import { AGUI_PROTOCOL_VERSION, AGUI_VERSION, BudgetSchema, DisplaySchema, JournalHistorySchema, MAX_RECORDING_BYTES, PlanSchema,
  RecordingSchema, SeenSchema, StartSchema, iso, recordedTickFailed, type Gap, type JournalHistory, type JournalRecord,
  type Recording, type RunLogEvent } from "./run-log-schema.js";

type Options = { exportedAt: string; display: Recording["display"]; progress?: ProgressRecord[]; progressGaps?: Gap[] };
/** A reconstruction of recorded observations. No IO, clock, signatures or decisions to send. */
export function tickLog(tick: Tick, history: JournalHistory, options: Options): Recording {
  const context = StartSchema.parse(tick);
  const journal = JournalHistorySchema.parse(history);
  if (journal.agentId !== context.agentId) throw new Error("Journal agent does not match tick agent");
  const display = DisplaySchema.parse(options.display);
  const exportedAt = iso.parse(options.exportedAt);
  const gaps: Gap[] = [...journal.gaps, ...(options.progressGaps ?? [])];
  if (tick.end?.progressIncomplete) gaps.push({ code: "progress_unavailable" });
  const events: RunLogEvent[] = [];
  const laterObservations: Recording["laterObservations"] = [];
  const threadId = `tick:${context.agentId}:${context.id}`;
  const endAt = tick.end ? iso.parse(tick.end.endedAt) : null;
  const gap = (code: string, ref?: string) => gaps.push({ code, ...(ref && { ref }) });
  const metadata = (ref: string, recordedAt: string | null, observedAt: string | null, timing: "recorded" | "observed" | "unknown") => ({
    eventId: `${threadId}:${ref}`, source: "tick" as const, recordRef: `${context.id}/${ref}`, recordedAt, observedAt, timing,
  });
  events.push({ type: "RUN_STARTED", threadId, runId: context.id, protocolVersion: AGUI_PROTOCOL_VERSION,
    timestamp: Date.parse(context.at), metadata: metadata("start", context.at, null, "recorded") });
  const activeStages = new Set<string>();
  for (const row of options.progress ?? []) {
    if (row.agentId !== context.agentId || row.tickId !== context.id) throw new Error("Progress identity mismatch");
    events.push({ ...row.event, timestamp: Date.parse(row.at), metadata: metadata(`progress:${row.sequence}`, row.at, null, "recorded") });
    if (row.event.type === "STEP_STARTED") activeStages.add(row.event.stepName);
    if (row.event.type === "STEP_FINISHED") activeStages.delete(row.event.stepName);
  }
  if (endAt && Date.parse(endAt) < Date.parse(context.at)) gap("clock_inconsistent", "end");

  const custom = (ref: string, value: Extract<RunLogEvent, { type: "CUSTOM" }>["value"], observedAt: string | null = null) => {
    events.push({ type: "CUSTOM", name: "treasury.observation", value,
      ...(observedAt && { timestamp: Date.parse(observedAt) }), metadata: metadata(ref, endAt, observedAt, observedAt ? "observed" : "unknown") });
  };
  const observation = (stage: "before" | "after", raw: NonNullable<Tick["end"]>["before"]) => {
    let projected: unknown = raw;
    if (!("error" in raw)) {
      const budget = BudgetSchema.safeParse(raw.budget);
      if (!budget.success && raw.budget !== null) gap("budget_unavailable", stage);
      projected = { ...raw, budget: budget.success ? budget.data : null };
    }
    const parsed = SeenSchema.safeParse(projected);
    const value = parsed.success ? parsed.data : { error: "Observation record is invalid" };
    if ("error" in value) gap("observation_unavailable", stage);
    else if (Date.parse(value.at) < Date.parse(context.at) || Date.parse(value.at) > Date.parse(endAt!)) gap("clock_inconsistent", stage);
    custom(stage, { stage, observation: value }, "error" in value ? null : value.at);
  };

  if (tick.end) {
    const end = tick.end;
    // Reject oversized input before expanding it into events.
    if (end.steps.length + end.shields.length > 1000) throw new Error("Too many tick operations");
    const plan = end.plan ? PlanSchema.parse(end.plan) : null;
    const correlations = [...end.shields, ...end.steps].map((s) => s.correlationId).filter(Boolean);
    const submissions = (options.progress ?? []).flatMap(row =>
      row.event.type === "CUSTOM" ? [row.event.value] : []);
    const used = new Set<string>();
    const joinHistory = (cid: string, method: "swap" | "shield" | "transfer" | "unshield", ref: string): { history: JournalRecord[]; untimedHistory: JournalRecord[] } => {
      const empty = { history: [], untimedHistory: [] };
      if (!cid) { gap("correlation_missing", ref); return empty; }
      const receipts = correlations.filter(id => id === cid);
      const accepted = submissions.filter(event => event.correlationId === cid);
      if (used.has(cid) || receipts.length > 1 || accepted.length > 1 ||
          accepted.some(event => event.method !== method) || (!receipts.length && !accepted.length)) {
        gap("association_conflict", ref); return empty;
      }
      used.add(cid);
      const keys = [...new Set(journal.records.filter((r) => r.correlationId === cid).map((r) => r.idempotencyKey))];
      if (keys.length !== 1) { gap(keys.length ? "association_conflict" : "association_missing", ref); return empty; }
      const rows = journal.records.filter((r) => r.idempotencyKey === keys[0]);
      const requests = rows.filter((r) => r.type === "request");
      if (requests.length !== 1 || rows.some((r) => r.correlationId && r.correlationId !== cid) ||
          requests.some((r) => (r.method && r.method !== method) || (method === "swap" && r.planId && r.planId !== plan?.id))) {
        gap("association_conflict", ref); return empty;
      }
      const within: JournalRecord[] = [];
      const untimed: JournalRecord[] = [];
      let previous = -Infinity;
      for (const row of rows) {
        if (!row.recordedAt) { untimed.push(row); continue; }
        const time = Date.parse(row.recordedAt);
        if (time < previous || time < Date.parse(context.at)) gap("clock_inconsistent", `journal:${row.line}`);
        previous = time;
        if (time > Date.parse(endAt!)) laterObservations.push({ correlationId: cid, source: "journal", record: row });
        else within.push(row);
      }
      const terminal = new Set(within.filter((r) => r.type === "status" && r.status !== undefined && isTerminal(r.status)).map((r) => r.status));
      if (terminal.size > 1) gap("status_conflict", ref);
      return { history: within, untimedHistory: untimed };
    };
    observation("before", end.before);
    end.shields.forEach((shield, index) => custom(`shield:${index}`, {
      stage: "shield", index, asset: shield.asset, correlationId: shield.correlationId, status: shield.status, failureCode: null, historySource: "journal",
      ...joinHistory(shield.correlationId, "shield", `shield:${index}`),
    }));
    custom("plan", { stage: "plan", plan, summary: end.outcome, rejected: end.rejected });
    end.steps.forEach((step, ordinal) => {
      if (!plan?.legs[step.index] || end.steps.filter((s) => s.index === step.index).length > 1) gap("plan_step_mismatch", `send:${ordinal}`);
      custom(`send:${ordinal}`, { stage: "send", index: step.index, correlationId: step.correlationId, status: step.status, failureCode: step.failureCode, historySource: "journal",
        ...joinHistory(step.correlationId, "swap", `send:${ordinal}`) });
    });
    // A status read can throw after acceptance, before executePlan/sweep yields a receipt.
    // The durable submission still identifies the operation; never invent a completed step.
    for (const submission of submissions) {
      if (correlations.includes(submission.correlationId) || used.has(submission.correlationId)) continue;
      const ref = `submission:${submission.correlationId}`;
      gap("submission_missing_from_receipt", ref);
      joinHistory(submission.correlationId, submission.method, ref);
    }
    observation("after", end.after);
    const result = { outcome: end.outcome, refusal: end.refusal, rejected: end.rejected };
    const failed = recordedTickFailed(result);
    if (activeStages.size && !gaps.some(g => g.code === "progress_incomplete")) gap("progress_incomplete", "end");
    if (failed || activeStages.size) {
      // A run error ends open protocol spans; it never invents a recorded stage return.
      // The original tick result remains evidence, separate from every operation's outcome.
      events.push({ type: "RUN_ERROR", code: failed ? "tick_failed" : "progress_incomplete",
        message: failed ? end.outcome : "Run end recorded, but one or more stage returns are missing.",
        timestamp: Date.parse(endAt!), metadata: { ...metadata("end", endAt, null, "recorded"), tickResult: result } });
    } else {
      events.push({ type: "RUN_FINISHED", threadId, runId: context.id, timestamp: Date.parse(endAt!),
        result, metadata: metadata("end", endAt, null, "recorded") });
    }
  }
  const assets = new Set(display.assets.map((a) => a.asset));
  if (tick.end) {
    const needed = new Set<string>([...tick.end.shields.map((s) => s.asset), ...(tick.end.plan?.legs.flatMap((l) => [l.from, l.to]) ?? [])]);
    for (const seen of [tick.end.before, tick.end.after]) if (!("error" in seen)) for (const row of seen.book) needed.add(row.asset);
    for (const asset of needed) if (!assets.has(asset)) gap("asset_display_missing", asset);
  }
  if (assets.size !== display.assets.length) throw new Error("Duplicate asset display identity");
  const recording = RecordingSchema.parse({ schemaVersion: 3, aguiVersion: AGUI_VERSION, agentId: context.agentId, tickId: context.id,
    exportedAt, completion: endAt ? "recorded-end" : "no-recorded-end", context, display, gaps, events,
    laterObservations: laterObservations.sort((a, b) => a.record.line - b.record.line) });
  bounded(JSON.stringify(recording)); // Already validated; bound the expanded payload once.
  return recording;
}

/** Bounds are measured in UTF-8 bytes in both Node and a future isolated browser player. */
function bounded(source: string) {
  if (source.length > MAX_RECORDING_BYTES || new TextEncoder().encode(source).length > MAX_RECORDING_BYTES) throw new Error("Recording is too large");
}
export function parseRecording(source: string): Recording {
  bounded(source);
  return RecordingSchema.parse(JSON.parse(source));
}
export function serializeRecording(recording: Recording): string {
  const source = JSON.stringify(RecordingSchema.parse(recording));
  bounded(source);
  return source;
}
