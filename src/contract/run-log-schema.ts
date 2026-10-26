import { EventSchemas } from "@ag-ui/core/schemas";
import { PROTOCOL_VERSION } from "@ag-ui/core";
import { z } from "zod";
import { StepNameSchema, SubmissionSchema } from "./run-progress-schema.js";

/** Private, observational format. No field in this module may authorize an operation. */
export const AGUI_VERSION = "1.0.3";
/** Earlier package versions whose recordings stay readable: their events still parse with the current schemas. */
const READABLE_AGUI_VERSIONS = ["1.0.2", AGUI_VERSION] as const;
export const AGUI_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const MAX_RECORDING_BYTES = 2_000_000;
export const text = z.string().max(4096);
export const id = z.string().min(1).max(200);
export const iso = z.iso.datetime({ offset: true });
const units = z.string().regex(/^\d+$/).max(200);
const number = z.number().finite();
export const GapSchema = z.strictObject({ code: id, line: z.number().int().positive().optional(), ref: text.optional() });
export type Gap = z.infer<typeof GapSchema>;

/** A safe projection of one physical journal line, not the folded operation or its raw request. */
export const JournalRecordSchema = z.strictObject({
  line: z.number().int().positive(), recordedAt: iso.nullable(), idempotencyKey: id,
  type: z.enum(["request", "submission-claim", "status", "refusal"]),
  method: z.enum(["swap", "transfer", "shield", "unshield"]).optional(),
  planId: id.optional(), correlationId: id.optional(), status: id.optional(), refusal: id.optional(),
});
export type JournalRecord = z.infer<typeof JournalRecordSchema>;
export const JournalHistorySchema = z.strictObject({ agentId: id, records: z.array(JournalRecordSchema).max(20_000), gaps: z.array(GapSchema).max(20_001) });
export type JournalHistory = z.infer<typeof JournalHistorySchema>;

export const StartSchema = z.object({
  progressVersion: z.literal(1).optional(),
  id, agentId: id, at: iso, trigger: z.enum(["schedule", "operator"]),
  schedule: z.object({ on: z.boolean(), everyMin: number, maxUsd: number, lastRun: iso.nullable() }),
  build: z.object({ deployment: text.nullable(), source: text, lockfile: text.nullable(), packageJson: text.nullable() }),
  policy: z.object({ revision: number.nullable(), digest: text.nullable(), status: text }), strategy: text,
  grant: z.object({ id, label: text, expiresAt: iso }).nullable(),
});
const window = z.object({ limit_usd: z.string().max(200).nullable(), remaining_usd: z.string().max(200).nullable() });
export const BudgetSchema = z.object({ daily: window, weekly: window, monthly: window });
export const SeenSchema = z.union([
  z.object({ error: text }),
  z.object({ at: iso, book: z.array(z.object({ asset: id, public: units, confidential: units, usd: number })).max(500),
    weightsBps: z.record(id, number), targetBps: z.record(id, number), driftBps: number, budget: BudgetSchema.nullable(), unresolved: z.number().int().nonnegative() }),
]);
export const PlanSchema = z.object({ id, usd: number, legs: z.array(z.object({
  from: id, to: id, amount: units, amountOut: units, minAmountOut: units, costBps: number,
})).max(500) });
export const DisplaySchema = z.object({ asOf: iso, assets: z.array(z.object({ asset: id, symbol: z.string().min(1).max(80), decimals: z.number().int().min(0).max(255) })).max(500) });
const result = z.strictObject({ outcome: text, refusal: text.nullable(), rejected: z.array(text).max(500) });
/** The current tick recorder's explicit failure marker; provider operation statuses are independent. */
export const recordedTickFailed = (value: z.infer<typeof result>) => value.refusal === null && value.outcome.startsWith("Failed: ");
const provenance = z.strictObject({
  eventId: text, source: z.literal("tick"), recordRef: text, recordedAt: iso.nullable(),
  observedAt: iso.nullable(), timing: z.enum(["recorded", "observed", "unknown"]),
});
const operation = {
  index: z.number().int().nonnegative(), correlationId: z.string().max(200), status: id, failureCode: text.nullable(),
  historySource: z.literal("journal"),
  history: z.array(JournalRecordSchema).max(20_000), untimedHistory: z.array(JournalRecordSchema).max(20_000),
};
const payload = z.discriminatedUnion("stage", [
  SubmissionSchema,
  z.strictObject({ stage: z.literal("before"), observation: SeenSchema }),
  z.strictObject({ stage: z.literal("shield"), asset: id, ...operation }),
  z.strictObject({ stage: z.literal("plan"), plan: PlanSchema.nullable(), summary: text, rejected: z.array(text).max(500) }),
  z.strictObject({ stage: z.literal("send"), ...operation }),
  z.strictObject({ stage: z.literal("after"), observation: SeenSchema }),
]);
const base = { timestamp: z.number().finite().optional(), metadata: provenance };
const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("STEP_STARTED"), stepName: StepNameSchema, ...base }),
  z.strictObject({ type: z.literal("STEP_FINISHED"), stepName: StepNameSchema, ...base }),
  z.strictObject({ type: z.literal("RUN_STARTED"), threadId: text, runId: id, protocolVersion: z.literal(AGUI_PROTOCOL_VERSION).optional(), ...base }),
  z.strictObject({ type: z.literal("CUSTOM"), name: z.literal("treasury.observation"), value: payload, ...base }),
  z.strictObject({ type: z.literal("RUN_FINISHED"), threadId: text, runId: id, result, ...base }),
  z.strictObject({ type: z.literal("RUN_ERROR"), message: text, code: z.enum(["tick_failed", "progress_incomplete"]),
    timestamp: base.timestamp, metadata: provenance.extend({ tickResult: result }) }),
]).superRefine((event, ctx) => {
  if (!EventSchemas.safeParse(event).success) ctx.addIssue({ code: "custom", message: `Invalid AG-UI ${AGUI_VERSION} event` });
});
export type RunLogEvent = z.infer<typeof EventSchema>;

export const RecordingSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]), aguiVersion: z.enum(READABLE_AGUI_VERSIONS), agentId: id, tickId: id, exportedAt: iso,
  completion: z.enum(["recorded-end", "no-recorded-end"]), context: StartSchema, display: DisplaySchema,
  gaps: z.array(GapSchema).max(25_000), events: z.array(EventSchema).min(1).max(2000),
  laterObservations: z.array(z.strictObject({ correlationId: id, source: z.literal("journal"), record: JournalRecordSchema })).max(20_000),
}).superRefine((recording, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (recording.agentId !== recording.context.agentId || recording.tickId !== recording.context.id) fail("Recording identity mismatch");
  const events = recording.events;
  if (events[0]?.type !== "RUN_STARTED") fail("Missing run start");
  const current = recording.schemaVersion === 3;
  // v1/v2 are retained archives, not retroactively certified protocol streams.
  if (current && events[0]?.type === "RUN_STARTED" && events[0].protocolVersion !== AGUI_PROTOCOL_VERSION) fail("Missing protocol version");
  if (!current && events.some(event => event.type === "RUN_ERROR" || (event.type === "RUN_STARTED" && event.protocolVersion !== undefined))) fail("Lifecycle fields require recording version 3");
  const isProgress = (event: RunLogEvent) => event.type === "STEP_STARTED" || event.type === "STEP_FINISHED" || (event.type === "CUSTOM" && event.value.stage === "submission");
  if (recording.schemaVersion === 1 && events.some(isProgress)) fail("Progress requires recording version 2");
  if (recording.completion === "no-recorded-end" && (events.slice(1).some(e => !isProgress(e)) || recording.laterObservations.length)) fail("Incomplete tick has inferred events");
  const active = new Set<string>(), finished = new Set<string>();
  let progressAt = Date.parse(recording.context.at);
  for (const event of events.filter(isProgress)) {
    if (event.metadata.timing !== "recorded" || event.timestamp === undefined || event.timestamp < progressAt || event.timestamp > Date.parse(recording.exportedAt)) fail("Invalid progress timing");
    progressAt = event.timestamp ?? progressAt;
    if (event.type === "STEP_STARTED") {
      if (active.has(event.stepName) || finished.has(event.stepName)) fail("Repeated stage");
      active.add(event.stepName);
    } else if (event.type === "STEP_FINISHED") {
      if (!active.delete(event.stepName)) fail("Stage never started");
      finished.add(event.stepName);
    }
  }
  const end = events.at(-1);
  const terminal = end?.type === "RUN_FINISHED" || end?.type === "RUN_ERROR";
  if (recording.completion === "recorded-end" && !terminal) fail("Missing recorded end");
  if (terminal && events.filter(isProgress).some(event => event.timestamp! > end.timestamp!)) fail("Progress recorded after run end");
  if (current && end?.type === "RUN_FINISHED") {
    if (active.size) fail("Run finished with open stages");
    if (recordedTickFailed(end.result)) fail("Recorded failure requires run error");
  }
  if (end?.type === "RUN_ERROR") {
    if (end.code === "tick_failed" && !recordedTickFailed(end.metadata.tickResult)) fail("Run error lacks recorded failure");
    if (end.code === "progress_incomplete" && !active.size) fail("Progress error has no open stage");
  }
  const ids = new Set<string>();
  for (const [i, event] of events.entries()) {
    if (ids.has(event.metadata.eventId)) fail("Duplicate event identity");
    ids.add(event.metadata.eventId);
    if (event.type === "RUN_STARTED" && i !== 0) fail("Unexpected run start");
    if ((event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") && i !== events.length - 1) fail("Unexpected run end");
    if ((event.type === "RUN_STARTED" || event.type === "RUN_FINISHED") && (event.runId !== recording.tickId || event.threadId !== `tick:${recording.agentId}:${recording.tickId}`)) fail("Event identity mismatch");
    const time = event.metadata.timing === "recorded" ? event.metadata.recordedAt : event.metadata.observedAt;
    if (event.metadata.timing === "unknown" ? event.timestamp !== undefined : !time || event.timestamp !== Date.parse(time)) fail("Event timing mismatch");
  }
});
export type Recording = z.infer<typeof RecordingSchema>;
