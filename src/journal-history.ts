import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { id, iso, type Gap, type JournalHistory, type JournalRecord } from "./run-log-schema.js";
import { OPERATION_METHODS } from "./contract/owner-outputs.js";

const MAX_BYTES = 8_000_000;
const MAX_LINES = 20_000;
/** As `JournalHistorySchema` allows: a legacy line can project two records, so lines alone don't bound them. */
const MAX_RECORDS = 20_000;
const safeAgent = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/, "Invalid agent ID");
// The published record format supports only these methods. Other accepted operations, including withdrawals,
// market payments and limit orders, project without their method and with an explicit omission gap.
const request = z.object({ request: z.record(z.string(), z.unknown()), kind: id, method: z.enum(OPERATION_METHODS).optional(), planId: id.optional() });
const EXPORTED_METHODS = ["swap", "transfer", "shield", "unshield"] as const satisfies readonly NonNullable<JournalRecord["method"]>[];
const projectable = (method: string | undefined): JournalRecord["method"] => EXPORTED_METHODS.find(value => value === method);
// Cancellation finality has no public record shape. Recognize its isolated envelope without inventing an operation
// correlation or status; mixed lifecycle fields must remain malformed rather than hiding contradictory evidence.
const cancellationFinal = z.strictObject({ at: z.string().optional(), idempotencyKey: id, cancelFinal: z.literal(true) });
// The public record format has no market-binding or landing record. Recognize only their isolated v3 envelopes;
// report the omission explicitly, without exporting private terms or treating either payload as settlement evidence.
// This observational reader does not validate the payload's journal relationships or destination proof.
const marketMetadata = z.union([
  z.strictObject({ at: z.string().min(1), idempotencyKey: id, kind: z.literal("market-allocation"), journalVersion: z.literal(4),
    allocation: z.record(z.string(), z.unknown()) }),
  z.strictObject({ at: z.string().min(1), idempotencyKey: id, kind: z.literal("market-binding"), journalVersion: z.literal(3),
    binding: z.record(z.string(), z.unknown()) }),
  z.strictObject({ at: z.string().min(1), idempotencyKey: id, kind: z.literal("market-landing"), journalVersion: z.literal(3),
    marketLanding: z.record(z.string(), z.unknown()) }),
]);

/** Pure parsing of a bounded, agent-scoped journal snapshot. Never return raw input in errors. */
export function parseJournalHistory(agentId: string, source: string): JournalHistory {
  safeAgent.parse(agentId);
  const records: JournalRecord[] = [];
  const gaps: Gap[] = [];
  if (Buffer.byteLength(source, "utf8") > MAX_BYTES) return { agentId, records, gaps: [{ code: "journal_too_large" }] };
  const lines = source.split("\n");
  for (let index = 0; index < Math.min(lines.length, MAX_LINES); index++) {
    const line = index + 1;
    if (!lines[index]!.trim()) continue;
    try {
      const raw = JSON.parse(lines[index]!);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
      const idempotencyKey = id.parse(raw.idempotencyKey);
      if (raw.journalVersion === 3 || raw.journalVersion === 4 || raw.kind === "market-allocation" || raw.kind === "market-binding" || raw.kind === "market-landing" ||
          "binding" in raw || "marketLanding" in raw) {
        const metadata = marketMetadata.parse(raw);
        gaps.push({ code: "market_metadata_not_exported", line, ref: metadata.kind });
        continue;
      }
      if ("cancelFinal" in raw) {
        cancellationFinal.parse(raw);
        gaps.push({ code: "cancel_final_not_exported", line });
        continue;
      }
      const tags = ["request", "submissionState", "correlation_id", "refused"].filter((key) => key in raw);
      // Historical authorization snapshots are metadata the fold skips: neither a record nor a gap.
      if (!tags.length && "authorization" in raw) continue;
      // A legacy snapshot could combine the request with its observed provider identity: one request, then one status.
      const legacy = tags.length === 2 && tags[0] === "request" && tags[1] === "correlation_id" && raw.journalVersion === undefined;
      if (tags.length !== 1 && !legacy) throw new Error();
      const time = iso.safeParse(raw.at);
      const base = { line, idempotencyKey, recordedAt: time.success ? time.data : null };
      const projected: JournalRecord[] = [];
      for (const tag of tags) switch (tag) {
        case "request": {
          const parsed = request.parse(raw);
          const method = projectable(parsed.method);
          if (parsed.method && !method) gaps.push({ code: "method_not_exported", line });
          projected.push({ ...base, type: "request", ...method && { method }, ...parsed.planId && { planId: parsed.planId } });
          break;
        }
        case "submissionState":
          if (raw.submissionState !== "SUBMISSION_ATTEMPTED") throw new Error();
          projected.push({ ...base, type: "submission-claim" });
          break;
        case "correlation_id":
          // Older logs may have a correlation ID without a status: still unresolved, never inferred terminal.
          projected.push({ ...base, type: "status", correlationId: id.parse(raw.correlation_id), ...raw.status !== undefined && { status: id.parse(raw.status) } });
          break;
        case "refused":
          projected.push({ ...base, type: "refusal", refusal: id.parse(raw.refused) });
          break;
      }
      if (records.length + projected.length > MAX_RECORDS) { gaps.push({ code: "journal_record_limit", line }); break; }
      records.push(...projected);
      if (!time.success) gaps.push({ code: raw.at === undefined ? "timestamp_missing" : "timestamp_invalid", line });
    } catch { gaps.push({ code: "malformed_line", line }); }
  }
  if (lines.slice(MAX_LINES).some((line) => line.trim())) gaps.push({ code: "journal_line_limit" });
  return { agentId, records, gaps };
}

/** Reads only .ops/<agent>.jsonl under the explicit state root. No environment, mkdir, recovery or writes. */
export function readJournalHistory(root: string, agentId: string): JournalHistory {
  safeAgent.parse(agentId);
  let fd: number | undefined;
  try {
    fd = openSync(join(root, ".ops", `${agentId}.jsonl`), "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_BYTES) return { agentId, records: [], gaps: [{ code: "journal_too_large" }] };
    return parseJournalHistory(agentId, buffer.subarray(0, size).toString("utf8"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { agentId, records: [], gaps: [{ code: missing ? "journal_missing" : "journal_unavailable" }] };
  } finally { if (fd !== undefined) closeSync(fd); }
}
