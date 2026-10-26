import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tick } from "../src/evidence.js";
import { tickLog, parseRecording, serializeRecording } from "../src/agui.js";
import { parseJournalHistory } from "../src/journal-history.js";
import { EventSchemas } from "@ag-ui/core/schemas";
import { PROTOCOL_VERSION } from "@ag-ui/core";
import type { ProgressEvent } from "../src/run-progress-schema.js";
import type { RunLogEvent } from "../src/run-log-schema.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const seen = (n: number) => ({ at: at(n), book: [{ asset: "usdc", public: "0", confidential: "10", usd: 10 }],
  weightsBps: { usdc: 10000 }, targetBps: { usdc: 10000 }, driftBps: 0, budget: null, unresolved: 0 });
const fixture = (): Tick => ({ id: "tick-1", agentId: "agent-a", at: at(0), trigger: "schedule",
  schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
  build: { deployment: null, source: "sha256:fixture", lockfile: null, packageJson: null },
  policy: { revision: 1, digest: "sha256:policy", status: "APPLIED" }, strategy: "sha256:strategy", grant: null,
  end: { endedAt: at(5), before: seen(0), after: seen(5), plan: { id: "plan-1", usd: 2,
    legs: ["near", "eth"].map((to) => ({ from: "usdc", to, amount: "1", amountOut: "1", minAmountOut: "1", costBps: 0 })) },
    steps: [0, 1].map((index) => ({ index, correlationId: `op-${index}`, status: "SUCCESS", failureCode: null })),
    shields: [], rejected: [], refusal: null, outcome: "two swaps" } });
const lines = (cid = "op-0", key = cid) => [
  { at: at(1), idempotencyKey: key, kind: "swap", method: "swap", request: { secret: "never-export" }, planId: "plan-1" },
  { at: at(1), idempotencyKey: key, submissionState: "SUBMISSION_ATTEMPTED" },
  { at: at(2), idempotencyKey: key, correlation_id: cid, status: "SENT" },
  { at: at(3), idempotencyKey: key, correlation_id: cid, status: "SUCCESS" },
];
const history = (rows: unknown[] = [...lines(), ...lines("op-1")], agent = "agent-a") =>
  parseJournalHistory(agent, rows.map((r) => JSON.stringify(r)).join("\n"));
const display = { asOf: at(6), assets: ["usdc", "near", "eth"].map((asset) => ({ asset, symbol: asset.toUpperCase(), decimals: 6 })) };
const log = (tick = fixture(), h = history()) => tickLog(tick, h, { exportedAt: at(6), display });
const withProgress = (tick: Tick, events: ProgressEvent[]) => tickLog(tick, history(), {
  exportedAt: at(6), display, progress: events.map((event, i) => ({
    version: 1, agentId: tick.agentId, tickId: tick.id, sequence: i + 1, at: at(i + 1), event,
  })),
});

// Independent consumer of the emitted lifecycle subset: unlike per-event SDK validation,
// this checks the AG-UI 1.0 sequence contract. An error closes open spans without a return.
function consume(events: RunLogEvent[]) {
  let state: "unstarted" | "running" | "finished" | "failed" = "unstarted";
  const active = new Set<string>();
  for (const event of events) {
    assert.ok(EventSchemas.safeParse(event).success);
    if (event.type === "RUN_STARTED") {
      assert.notEqual(state, "running", "nested run start");
      active.clear();
      state = "running";
    } else if (event.type === "RUN_ERROR") {
      assert.notEqual(state, "failed", "event after run error");
      active.clear();
      state = "failed";
    } else {
      assert.equal(state, "running", "event outside an open run");
      if (event.type === "STEP_STARTED") {
        assert.equal(active.has(event.stepName), false, "step is already open");
        active.add(event.stepName);
      } else if (event.type === "STEP_FINISHED") {
        assert.ok(active.delete(event.stepName), "step was not open");
      } else if (event.type === "RUN_FINISHED") {
        assert.equal(active.size, 0, "run finished with open steps");
        state = "finished";
      }
    }
  }
  return { state, open: [...active] };
}

test("two swaps produce deterministic, schema-valid observations and a private round trip", () => {
  const value = log();
  assert.deepEqual(value, log());
  assert.deepEqual(parseRecording(serializeRecording(value)), value);
  assert.equal(value.events[0]?.type, "RUN_STARTED");
  assert.equal(value.events.at(-1)?.type, "RUN_FINISHED");
  assert.deepEqual(consume(value.events), { state: "finished", open: [] });
  assert.equal(value.completion, "recorded-end");
  for (const event of value.events) assert.ok(EventSchemas.safeParse(event).success);
  assert.doesNotMatch(JSON.stringify(value), /never-export|STEP_STARTED|STEP_FINISHED/);
  assert.equal(value.events.filter((e) => e.type === "CUSTOM" && e.value.stage === "send").length, 2);
});

test("shields precede the plan and sends without invented stage timestamps", () => {
  const tick = fixture();
  tick.end!.shields = [{ asset: "usdc", correlationId: "shield-1", status: "SUCCESS" }];
  const rows = lines("shield-1").map((r) => "request" in r ? { ...r, method: "shield", planId: undefined } : r);
  const value = log(tick, history([...rows, ...lines(), ...lines("op-1")]));
  const stages = value.events.filter((e) => e.type === "CUSTOM").map((e) => e.value.stage);
  assert.deepEqual(stages, ["before", "shield", "plan", "send", "send", "after"]);
  const plan = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "plan")!;
  assert.equal(plan.timestamp, undefined);
  assert.equal(plan.metadata.recordedAt, at(5));
});

test("an interrupted tick has only a start, no guessed operation associations or finish", () => {
  const tick = fixture(); tick.end = null;
  const value = log(tick);
  assert.equal(value.completion, "no-recorded-end");
  assert.equal(value.events.length, 1);
  assert.equal(value.laterObservations.length, 0);
  assert.doesNotMatch(JSON.stringify(value), /op-0|op-1/);
});

test("no-plan and refusal ticks finish normally, without claiming every send settled", () => {
  const tick = fixture();
  Object.assign(tick.end!, { plan: null, steps: [], outcome: "book on target" });
  assert.equal(log(tick).events.at(-1)?.type, "RUN_FINISHED");
  Object.assign(tick.end!, { refusal: "policy_denied", outcome: "refused" });
  const last = log(tick).events.at(-1)!;
  assert.equal(last.type, "RUN_FINISHED");
  if (last.type === "RUN_FINISHED") assert.equal(last.result.refusal, "policy_denied");
});

test("a recorded end with an unfinished stage closes with an error, never an invented return", () => {
  const tick = fixture();
  tick.progressVersion = 1;
  const value = tickLog(tick, history(), { exportedAt: at(6), display, progress: [{
    version: 1, agentId: tick.agentId, tickId: tick.id, sequence: 1, at: at(1),
    event: { type: "STEP_STARTED", stepName: "execution" },
  }] });
  assert.equal(value.events.at(-1)?.type, "RUN_ERROR");
  assert.equal(value.events.some(event => event.type === "STEP_FINISHED"), false);
  assert.equal(value.completion, "recorded-end", "the source tick still has its original end");
  assert.deepEqual(consume(value.events), { state: "failed", open: [] });
  const end = value.events.at(-1)!;
  assert.ok(end.type === "RUN_ERROR");
  assert.equal(end.code, "progress_incomplete");
  assert.deepEqual(end.metadata.tickResult, { outcome: tick.end!.outcome, refusal: null, rejected: [] });
  assert.equal(end.metadata.recordedAt, tick.end!.endedAt);
  assert.equal(end.metadata.recordRef, "tick-1/end");
  assert.ok(value.gaps.some(gap => gap.code === "progress_incomplete"));
  assert.deepEqual(parseRecording(serializeRecording(value)), value);
});

test("a recorded execution failure cannot be exported as protocol success", () => {
  const tick = fixture();
  tick.end!.outcome = "Failed: provider read unavailable";
  const value = log(tick);
  assert.equal(value.events.at(-1)?.type, "RUN_ERROR");
  assert.equal(value.events.some(event => event.type === "RUN_FINISHED"), false);
  const end = value.events.at(-1)!;
  assert.ok(end.type === "RUN_ERROR");
  assert.equal(end.code, "tick_failed");
  assert.equal(end.message, tick.end!.outcome);
  assert.deepEqual(end.metadata.tickResult, { outcome: tick.end!.outcome, refusal: null, rejected: [] });
  assert.deepEqual(consume(value.events), { state: "failed", open: [] });
});

test("closed overlapping stages and proven refusals complete without guessing from error-looking prose", () => {
  const tick = fixture();
  const progress: ProgressEvent[] = [
    { type: "STEP_STARTED", stepName: "planning" },
    { type: "STEP_STARTED", stepName: "execution" },
    { type: "STEP_FINISHED", stepName: "planning" },
    { type: "STEP_FINISHED", stepName: "execution" },
  ];
  for (const outcome of ["failed status read", "status unavailable", "step 1: FAILED", "Outcome unknown after submission"]) {
    tick.end!.outcome = outcome;
    assert.deepEqual(consume(withProgress(tick, progress).events), { state: "finished", open: [] });
  }
  Object.assign(tick.end!, { outcome: "Failed: policy denied", refusal: "policy_denied" });
  const refused = withProgress(tick, progress);
  assert.deepEqual(consume(refused.events), { state: "finished", open: [] });
  const unclosed = withProgress(tick, progress.slice(0, 2));
  assert.deepEqual(consume(unclosed.events), { state: "failed", open: [] });
  const end = unclosed.events.at(-1)!;
  assert.ok(end.type === "RUN_ERROR");
  assert.equal(end.code, "progress_incomplete");
  assert.equal(end.metadata.tickResult.refusal, "policy_denied");
});

test("version 3 rejects successful ends with open steps, failed results, or events after an error", () => {
  const open = withProgress(fixture(), [{ type: "STEP_STARTED", stepName: "execution" }]);
  const successfulEnd = log().events.at(-1)!;
  assert.throws(() => parseRecording(JSON.stringify({ ...open, events: [...open.events.slice(0, -1), successfulEnd] })), /open stages/);
  const failed = log();
  const end = failed.events.at(-1)!;
  assert.ok(end.type === "RUN_FINISHED");
  end.result.outcome = "Failed: provider read unavailable";
  assert.throws(() => parseRecording(JSON.stringify(failed)), /requires run error/);
  const afterError = { ...open, events: [...open.events, successfulEnd] };
  assert.throws(() => parseRecording(JSON.stringify(afterError)), /Unexpected run end/);
  assert.throws(() => consume(afterError.events), /event outside an open run/);
  const wrongReason = structuredClone(open);
  const error = wrongReason.events.at(-1)!;
  assert.ok(error.type === "RUN_ERROR");
  error.code = "tick_failed";
  assert.throws(() => parseRecording(JSON.stringify(wrongReason)), /lacks recorded failure/);
});

test("legacy v1/v2 archives retain their original ends without claiming current lifecycle conformance", () => {
  const v1 = log();
  v1.schemaVersion = 1;
  const start = v1.events[0]!;
  assert.ok(start.type === "RUN_STARTED");
  delete start.protocolVersion;
  const end = v1.events.at(-1)!;
  assert.ok(end.type === "RUN_FINISHED");
  end.result.outcome = "Failed: legacy provider error";
  assert.deepEqual(parseRecording(serializeRecording(v1)), v1);

  const v2 = withProgress(fixture(), [{ type: "STEP_STARTED", stepName: "execution" }]);
  v2.schemaVersion = 2;
  const v2Start = v2.events[0]!;
  assert.ok(v2Start.type === "RUN_STARTED");
  delete v2Start.protocolVersion;
  const oldEnd = v2.events.pop()!;
  assert.ok(oldEnd.type === "RUN_ERROR");
  const { tickResult, ...metadata } = oldEnd.metadata;
  v2.events.push({ type: "RUN_FINISHED", threadId: v2Start.threadId, runId: v2Start.runId,
    timestamp: oldEnd.timestamp, result: tickResult, metadata });
  assert.deepEqual(parseRecording(serializeRecording(v2)), v2);
  assert.throws(() => consume(v2.events), /open steps/);
  assert.throws(() => parseRecording(JSON.stringify({ ...v2, schemaVersion: 3 })), /Missing protocol version/);
  assert.throws(() => parseRecording(JSON.stringify({ ...withProgress(fixture(), [{ type: "STEP_STARTED", stepName: "execution" }]), schemaVersion: 2 })), /version 3/);
});

test("late reconciliation never replaces the status recorded at tick end", () => {
  const tick = fixture(); tick.end!.steps[0]!.status = "SENT";
  const rows = lines().slice(0, 3);
  const value = log(tick, history([...rows, { ...lines()[3], at: at(7) }, ...lines("op-1")]));
  const send = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "send")!;
  assert.equal(send.type, "CUSTOM");
  if (send.type === "CUSTOM" && send.value.stage === "send") {
    assert.equal(send.value.status, "SENT");
    assert.equal(send.value.history.some((r) => r.status === "SUCCESS"), false);
  }
  assert.equal(value.laterObservations[0]?.record.status, "SUCCESS");
});

test("missing and malformed timing stays unknown; missing reads do not become zero balances", () => {
  const tick = fixture(); tick.end!.before = { error: "unavailable" };
  const value = log(tick, history([{ ...lines()[3], at: undefined }, ...lines("op-1")]));
  assert.ok(value.gaps.some((g) => g.code === "timestamp_missing"));
  assert.ok(value.gaps.some((g) => g.code === "observation_unavailable"));
  const before = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "before")!;
  assert.equal(before.timestamp, undefined);
});

test("scope mismatch throws, conflicting correlations and plans are not joined", () => {
  assert.throws(() => log(fixture(), history([], "other-agent")), /agent/i);
  const value = log(fixture(), history([...lines(), ...lines("op-0", "other-key"), ...lines("op-1")]));
  assert.ok(value.gaps.some((g) => g.code === "association_conflict"));
  const mismatch = log(fixture(), history(lines().map((r) => "request" in r ? { ...r, planId: "wrong-plan" } : r)));
  assert.ok(mismatch.gaps.some((g) => g.code === "association_conflict"));
});

test("missing correlations and partial execution stay explicit", () => {
  const tick = fixture(); tick.end!.steps = [{ index: 0, correlationId: "", status: "UNKNOWN", failureCode: null }];
  const value = log(tick);
  assert.ok(value.gaps.some((g) => g.code === "correlation_missing"));
  assert.equal(value.events.filter((e) => e.type === "CUSTOM" && e.value.stage === "send").length, 1);
  assert.doesNotMatch(JSON.stringify(value), /Not paid/);
});

test("import rejects unsupported versions, invalid events and oversized data", () => {
  const value = log();
  assert.throws(() => parseRecording(JSON.stringify({ ...value, schemaVersion: 99 })));
  assert.throws(() => parseRecording(JSON.stringify({ ...value, events: [{ type: "RUN_STARTED" }] })));
  assert.throws(() => parseRecording(" ".repeat(2_000_001)), /large/i);
  assert.throws(() => serializeRecording({ ...value, schemaVersion: 99 } as never));
});

test("export still bounds the complete expanded recording in UTF-8 bytes", () => {
  const tick = fixture();
  tick.end!.rejected = Array.from({ length: 400 }, () => "€".repeat(1000));
  assert.throws(() => log(tick), /Recording is too large/);
});

test("the pinned package and recording schema agree", () => {
  const require = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(require.resolve("@ag-ui/core/package.json"), "utf8"));
  const value = log();
  assert.equal(value.schemaVersion, 3);
  assert.equal(value.aguiVersion, pkg.version);
  const start = value.events[0]!;
  assert.ok(start.type === "RUN_STARTED");
  assert.equal(start.protocolVersion, PROTOCOL_VERSION);
  assert.equal(start.protocolVersion, "1.0", "wire protocol version is separate from the SDK package version");
  delete start.protocolVersion;
  assert.throws(() => parseRecording(JSON.stringify(value)), /Missing protocol version/);
});

test("unknown timings cannot be replaced by fabricated timestamps on import", () => {
  const value = log();
  value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "plan")!.timestamp = 123;
  assert.throws(() => parseRecording(JSON.stringify(value)), /timing mismatch/);
});

test("clock reversals preserve journal order and report uncertainty", () => {
  const rows = lines(); rows[3]!.at = at(1);
  const value = log(fixture(), history([...rows, ...lines("op-1")]));
  assert.ok(value.gaps.some((g) => g.code === "clock_inconsistent"));
  const event = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "send");
  if (event?.type === "CUSTOM" && event.value.stage === "send") {
    assert.deepEqual(event.value.history.map((r) => r.line), [1, 2, 3, 4]);
  } else assert.fail("missing send");
});

test("a key associated with two correlations is never joined to either operation", () => {
  const value = log(fixture(), history([...lines(), { ...lines()[3], correlation_id: "op-other" }]));
  const event = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "send");
  if (event?.type === "CUSTOM" && event.value.stage === "send") assert.deepEqual(event.value.history, []);
  else assert.fail("missing send");
  assert.ok(value.gaps.some((g) => g.code === "association_conflict"));
});

test("provider FAILED is preserved without converting it into proof of nonpayment", () => {
  const tick = fixture(); tick.end!.steps[0]!.status = "FAILED";
  const value = log(tick);
  const event = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "send");
  if (event?.type === "CUSTOM" && event.value.stage === "send") assert.equal(event.value.status, "FAILED");
  else assert.fail("missing send");
  assert.deepEqual(consume(value.events), { state: "finished", open: [] }, "an operation outcome is not a run execution failure");
  assert.doesNotMatch(JSON.stringify(value), /Not paid|safe to retry/);
});

test("contradictory journal outcomes are retained and flagged, never resolved by the adapter", () => {
  const value = log(fixture(), history([...lines(), { ...lines()[3], at: at(4), status: "FAILED" }, ...lines("op-1")]));
  assert.ok(value.gaps.some((g) => g.code === "status_conflict"));
  const event = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "send");
  if (event?.type === "CUSTOM" && event.value.stage === "send") {
    assert.equal(event.value.status, "SUCCESS", "the tick's original observation is retained");
    assert.deepEqual(event.value.history.filter((r) => r.type === "status").map((r) => r.status), ["SENT", "SUCCESS", "FAILED"]);
  } else assert.fail("missing send");
});

test("only explicit display/context/budget fields enter the recording", () => {
  const tick = fixture();
  Object.assign(tick, { secret: "never-export" });
  const before = tick.end!.before;
  if ("error" in before) assert.fail();
  const window = { limit_usd: "10", remaining_usd: "8", secret: "never-export" };
  before.budget = { daily: window, weekly: window, monthly: window, secret: "never-export" };
  const value = log(tick);
  assert.doesNotMatch(JSON.stringify(value), /never-export/);
  const missing = tickLog(tick, history(), { exportedAt: at(6), display: { asOf: at(6), assets: [] } });
  assert.ok(missing.gaps.some((g) => g.code === "asset_display_missing"));
});


test("recorded intermediate events survive an interrupted run without an invented finish", () => {
  const tick = fixture(); tick.end = null; tick.progressVersion = 1;
  const progress = [
    { version: 1 as const, agentId: tick.agentId, tickId: tick.id, sequence: 1, at: at(1), event: { type: "STEP_STARTED" as const, stepName: "execution" as const } },
    { version: 1 as const, agentId: tick.agentId, tickId: tick.id, sequence: 2, at: at(2), event: { type: "CUSTOM" as const, name: "treasury.observation" as const, value: { stage: "submission" as const, method: "swap" as const, correlationId: "accepted-op" } } },
  ];
  const value = tickLog(tick, history([]), { exportedAt: at(6), display, progress });
  assert.equal(value.schemaVersion, 3);
  assert.equal(value.completion, "no-recorded-end");
  assert.deepEqual(value.events.map(e => e.type), ["RUN_STARTED", "STEP_STARTED", "CUSTOM"]);
  assert.deepEqual(consume(value.events), { state: "running", open: ["execution"] });
  for (const event of value.events) assert.ok(EventSchemas.safeParse(event).success);
  assert.deepEqual(parseRecording(serializeRecording(value)), value);
  assert.throws(() => parseRecording(JSON.stringify({ ...value, schemaVersion: 1 })), /version 2/);
  const finish = { ...value.events[1], type: "STEP_FINISHED" };
  assert.throws(() => parseRecording(JSON.stringify({ ...value, events: [value.events[0], finish] })), /never started/);
});

const submission = (method: "swap" | "shield" = "swap", correlationId = "op-0") => ({
  version: 1 as const, agentId: "agent-a", tickId: "tick-1", sequence: 1, at: at(2),
  event: { type: "CUSTOM" as const, name: "treasury.observation" as const,
    value: { stage: "submission" as const, method, correlationId } },
});

test("accepted operations missing from the tick receipt retain later journal outcomes", () => {
  for (const method of ["swap", "shield"] as const) {
    const tick = fixture(); tick.progressVersion = 1;
    tick.end!.steps = []; tick.end!.outcome = "Outcome unknown after submission";
    const rows = lines().map(row => "request" in row ? { ...row, method } : { ...row, at: "status" in row && row.status === "SUCCESS" ? at(7) : row.at });
    const value = tickLog(tick, history(rows), { exportedAt: at(8), display, progress: [submission(method)] });
    assert.equal(value.laterObservations[0]?.record.status, "SUCCESS");
    assert.ok(value.gaps.some(g => g.code === "submission_missing_from_receipt"));
    assert.equal(value.events.filter(e => e.type === "CUSTOM" && (e.value.stage === "send" || e.value.stage === "shield")).length, 0);
    assert.deepEqual(parseRecording(serializeRecording(value)), value);
  }
});

test("submission and receipt for the same operation join later outcomes only once", () => {
  const rows = [...lines().slice(0, 3), { ...lines()[3], at: at(7) }, ...lines("op-1")];
  const value = tickLog(fixture(), history(rows), { exportedAt: at(8), display, progress: [submission()] });
  assert.equal(value.laterObservations.length, 1);
  assert.ok(!value.gaps.some(g => g.code === "association_conflict"));
});

test("conflicting submission identities never attach later outcomes", () => {
  const tick = fixture(); tick.end!.steps = [];
  const rows = [...lines().slice(0, 3), { ...lines()[3], at: at(7) }];
  for (const progress of [[submission("shield")], [submission(), { ...submission(), sequence: 2 }]]) {
    const value = tickLog(tick, history(rows), { exportedAt: at(8), display, progress });
    assert.equal(value.laterObservations.length, 0);
    assert.ok(value.gaps.some(g => g.code === "association_conflict"));
  }
});

test("recordings exported under AG-UI 1.0.2 stay readable after the package moved to 1.0.3", () => {
  const value = log();
  assert.equal(value.aguiVersion, "1.0.3");
  const earlier = parseRecording(JSON.stringify({ ...value, aguiVersion: "1.0.2" }));
  assert.equal(earlier.aguiVersion, "1.0.2");
  assert.throws(() => parseRecording(JSON.stringify({ ...value, aguiVersion: "1.0.1" })));
});
