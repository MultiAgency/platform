import { api, readStatus } from "./api.js";
import { agentId } from "./env.js";
import { heldSwapShapes } from "./held-swap.js";

// `pnpm inspect-held-swap <correlation id>`: step 3 of docs/platform-staging.md "What a held swap's approval commits
// to". Reads the held swap's status, its approval and the confidential balances, then reports which candidate shape
// recomputes the approval's request hash. Read-only: it never sends, signs or votes.
const correlationId = process.argv[2];
if (!correlationId) { console.error("Usage: pnpm inspect-held-swap <correlation id>"); process.exit(2); }

const id = agentId();
const status = await readStatus(correlationId);
const details = ("details" in status ? status.details : {}) as Record<string, unknown>;
if (status.agent_id !== id || status.status !== "PENDING_APPROVAL" || typeof details.approval_id !== "string") {
  console.error(`Not a held operation of this agent: ${status.status}. Stop, don't reject or resend, and report (runbook stop rules).`);
  process.exit(1);
}
const [approval, balances] = await Promise.all([api.getApproval(id, details.approval_id), api.getBalances(id, { source: "confidential" })]);
const { shapes, matched, outcome } = heldSwapShapes(approval);
const assets = new Set(Object.values(approval.request_data).filter(v => typeof v === "string"));
console.dir({
  status: { type: status.type, status: status.status, details },
  approval: { approval_id: approval.approval_id, status: approval.status, request_type: approval.request_type, request_data: approval.request_data,
    request_hash: approval.request_hash, expires_at: approval.expires_at },
  balances: balances.balances.filter(b => assets.has(b.asset_id)).map(b => ({ asset_id: b.asset_id, balance_raw: b.balance_raw, available_raw: b.available_raw })),
  shapes, matched, outcome,
}, { depth: null });
