import { blocksDispatch, isHeld, type Op } from "./ops.js";
import { ageMinutes, methodOf, openOps, recover } from "./recover.js";
import { describeEvidence, readSubmissionEvidence } from "./submission-evidence.js";

// `pnpm reconcile` lists money actions without a proven outcome; `--poll` reads their statuses once.
// Nothing is ever resent: provider deduplication is unverified.

const evidence = readSubmissionEvidence();
const label = (op: Op) => {
  const last = evidence.get(op.idempotencyKey)?.at(-1);
  return `${op.idempotencyKey} (${methodOf(op)}, ${ageMinutes(op)} min old, ${op.status ? `last ${op.status}` : "no response"}${last ? `; ${describeEvidence(last)}` : ""})`;
};
const state = (op: Op) => (blocksDispatch(op) ? "unresolved" : isHeld(op) ? "held" : "prepared");

if (!process.argv.includes("--poll")) {
  const open = openOps();
  if (open.length === 0) console.log("Every money action has a proven outcome.");
  for (const op of open) console.log(`${state(op)} ${label(op)}`);
  if (open.length > 0) console.log("\nPass --poll for status-only recovery. Nothing is resent; provider deduplication is unverified.");
} else {
  const recoveries = await recover();
  if (recoveries.length === 0) console.log("Every money action has a proven outcome.");
  for (const { op, outcome, status, detail } of recoveries)
    console.log(`${outcome}${status ? ` ${status}` : ""}${detail ? ` (${detail})` : ""}: ${label(op)}`);
  if (recoveries.some((r) => r.outcome === "open")) console.log("\nSome are still open: run again to follow them.");
}
