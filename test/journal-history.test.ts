import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJournalHistory, readJournalHistory } from "../src/journal-history.js";
import { JournalHistorySchema } from "../src/contract/run-log-schema.js";
import { briefDigest } from "../src/market/x402.js";
import { requestKey } from "../src/request-key.js";

const row = { at: "2026-01-01T00:00:00Z", idempotencyKey: "k", correlation_id: "op", status: "SENT" };
test("raw reader preserves line order, duplicates and source gaps without exposing raw payloads", () => {
  const source = [JSON.stringify(row), "", "{truncated", JSON.stringify({ ...row, at: undefined }), JSON.stringify(row)].join("\n");
  const h = parseJournalHistory("agent", source);
  assert.deepEqual(h.records.map((r) => r.line), [1, 4, 5]);
  assert.equal(h.records[1]?.recordedAt, null);
  assert.ok(h.gaps.some((g) => g.code === "malformed_line" && g.line === 3));
  assert.ok(h.gaps.some((g) => g.code === "timestamp_missing" && g.line === 4));
  assert.doesNotMatch(JSON.stringify(h), /truncated/);
});
test("invalid dates and ambiguous line shapes cannot become trusted timestamps or statuses", () => {
  const h = parseJournalHistory("agent", [JSON.stringify({ ...row, at: "yesterday" }), JSON.stringify({ ...row, refused: "denied" })].join("\n"));
  assert.equal(h.records[0]?.recordedAt, null);
  assert.ok(h.gaps.some((g) => g.code === "timestamp_invalid"));
  assert.ok(h.gaps.some((g) => g.code === "malformed_line"));
});
test("file reads never create a missing journal or change a present journal", () => {
  const root = mkdtempSync(join(tmpdir(), "run-log-"));
  try {
    assert.equal(readJournalHistory(root, "agent").gaps[0]?.code, "journal_missing");
    mkdirSync(join(root, ".ops"));
    const file = join(root, ".ops", "agent.jsonl");
    const source = JSON.stringify(row) + "\n";
    writeFileSync(file, source);
    assert.equal(readJournalHistory(root, "agent").records.length, 1);
    assert.equal(readFileSync(file, "utf8"), source);
    assert.throws(() => readJournalHistory(root, "../other"), /agent/i);
    writeFileSync(file, " ".repeat(8_000_001));
    assert.equal(readJournalHistory(root, "agent").gaps[0]?.code, "journal_too_large");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("line limits and unsupported record shapes remain explicit gaps", () => {
  const h = parseJournalHistory("agent", "\n".repeat(20_000) + JSON.stringify(row));
  assert.deepEqual(h.records, []);
  assert.equal(h.gaps[0]?.code, "journal_line_limit");
  assert.equal(parseJournalHistory("agent", JSON.stringify({ idempotencyKey: "k", submissionState: "other" })).gaps[0]?.code, "malformed_line");
});

test("every legacy or v2 operation line shape projects without a malformed gap", () => {
  const at = "2026-01-01T00:00:00Z";
  const source = [
    { at, idempotencyKey: "w", kind: "payout", request: {}, method: "withdraw", journalVersion: 2 },
    { at, idempotencyKey: "l", kind: "swap", request: {}, correlation_id: "op-l", status: "SENT" },
    { at, idempotencyKey: "n", correlation_id: "op-n" },
    { at, idempotencyKey: "a", authorization: { version: 1 } },
    { at, idempotencyKey: "x", kind: "market-hire", request: {}, method: "x402", journalVersion: 2 },
  ].map((line) => JSON.stringify(line)).join("\n");
  const h = parseJournalHistory("agent", source);
  // A withdrawal's or a market payment's method isn't in the published record, so the export says it was dropped, not
  // that none was recorded.
  assert.deepEqual(h.gaps, [{ code: "method_not_exported", line: 1 }, { code: "method_not_exported", line: 5 }]);
  assert.deepEqual(h.records.map(({ line, idempotencyKey, type, correlationId, status, method }) => ({ line, idempotencyKey, type, correlationId, status, method })), [
    { line: 1, idempotencyKey: "w", type: "request", correlationId: undefined, status: undefined, method: undefined },
    { line: 2, idempotencyKey: "l", type: "request", correlationId: undefined, status: undefined, method: undefined },
    { line: 2, idempotencyKey: "l", type: "status", correlationId: "op-l", status: "SENT", method: undefined },
    { line: 3, idempotencyKey: "n", type: "status", correlationId: "op-n", status: undefined, method: undefined },
    { line: 5, idempotencyKey: "x", type: "request", correlationId: undefined, status: undefined, method: undefined },
  ]);
});

const marketKey = requestKey("app:fixture:acme", "hire-1");
const marketBinding = {
  at: "2026-11-11T00:00:00Z", idempotencyKey: marketKey, kind: "market-binding", journalVersion: 3,
  binding: { actor: "app:fixture:acme", requestId: "hire-1", brief: "Private market brief",
    approved: { handle: "writer", brief: briefDigest("Private market brief"), network: "near:mainnet",
      asset: "a".repeat(64), payTo: "private-payee.near", amount: "500000", maxTimeoutSeconds: 900 },
    paymentAccount: "private-payment.near", publicKey: `ed25519:${"A".repeat(43)}` },
};
const marketLanding = {
  at: "2026-11-11T00:00:01Z", idempotencyKey: marketKey, kind: "market-landing", journalVersion: 3,
  marketLanding: { stage: "usdc", correlationId: "funding-op", destinationTxHash: "private-destination-hash", finalHeight: "123" },
};

test("v3 market metadata remains an explicit export gap without becoming payment evidence or corrupting adjacent history", () => {
  const source = [marketBinding, { ...row, idempotencyKey: `${marketKey}:market-usdc` }, marketLanding]
    .map(line => JSON.stringify(line)).join("\n");
  const history = parseJournalHistory("agent", source);
  assert.deepEqual(history.gaps, [
    { code: "market_metadata_not_exported", line: 1, ref: "market-binding" },
    { code: "market_metadata_not_exported", line: 3, ref: "market-landing" },
  ]);
  assert.deepEqual(history.records.map(({ line, type, status }) => ({ line, type, status })), [
    { line: 2, type: "status", status: "SENT" },
  ], "a binding or landing is neither an operation request nor a payment status");
  assert.doesNotThrow(() => JournalHistorySchema.parse(history), "the public record schema remains compatible");
  assert.doesNotMatch(JSON.stringify(history), /Private market brief|private-payee|private-payment|private-destination-hash/);
});

for (const [name, line] of Object.entries({
  "unknown version": { ...marketBinding, journalVersion: 4 },
  "missing binding": { ...marketBinding, binding: undefined },
  "non-object binding": { ...marketBinding, binding: [] },
  "mixed payment": { ...marketBinding, request: {} },
  "mixed submission": { ...marketLanding, submissionState: "SUBMISSION_ATTEMPTED" },
  "mixed outcome": { ...marketLanding, correlation_id: "funding-op", status: "SUCCESS" },
  "mixed refusal": { ...marketLanding, refused: "never_submitted" },
  "mixed metadata": { ...marketBinding, authorization: { version: 1 } },
  "both metadata kinds": { ...marketBinding, marketLanding: marketLanding.marketLanding },
})) test(`invalid v3 market metadata (${name}) stays a malformed gap`, () => {
  assert.deepEqual(parseJournalHistory("agent", JSON.stringify(line)), {
    agentId: "agent", records: [], gaps: [{ code: "malformed_line", line: 1 }],
  });
});

test("legacy lines that each project two records stay within the record limit and say so", () => {
  const line = (n: number) => JSON.stringify({ at: "2026-01-01T00:00:00Z", idempotencyKey: `k${n}`, kind: "swap", request: {}, correlation_id: `c${n}`, status: "SUCCESS" });
  const h = parseJournalHistory("agent", Array.from({ length: 10_001 }, (_, n) => line(n)).join("\n"));
  assert.equal(h.records.length, 20_000);
  assert.ok(h.gaps.some(g => g.code === "journal_record_limit"));
  assert.doesNotThrow(() => JournalHistorySchema.parse(h));
});
