import { api, readStatus } from "./api.js";
import { agentId } from "./env.js";
import { isHeld, readOps, settle } from "./ops.js";
import { paymentEvidence } from "./provider-display.js";

/** How long a held payout stays approvable: the API keeps an approval open for 24 hours. */
const APPROVAL_TTL_MS = 24 * 60 * 60_000;

/**
 * Money actions waiting for the owner's approval, each with the approval that releases it. Any
 * that moved on since are recorded instead. A released payout still processing is unresolved
 * and blocks new money actions until its outcome is known. The API's approvals list can come back empty while one is pending (seen on
 * mainnet), so each held execution's own status is the source.
 *
 * Historical payouts absent from the local store come from the API's history, as kind "remote",
 * and are never written here. Current invoice and dashboard submissions share this executor and
 * local activity. Dashboard review requests complete history and surfaces failures; legacy internal callers may request the local fallback.
 */
export async function held({ complete = false }: { complete?: boolean } = {}) {
  const local = readOps().filter(isHeld);
  const waiting = [];
  for (const op of local) {
    const status = await readStatus(op.correlationId!);
    const approvalId = (status.details as { approval_id?: string } | null)?.approval_id;
    if (status.status === "PENDING_APPROVAL" && approvalId)
      waiting.push({ at: op.at, kind: op.kind, request: op.request, correlationId: status.correlation_id, approvalId });
    else if (status.status !== "PENDING_APPROVAL") settle(status.correlation_id, status.status);
  }
  const mine = new Set(local.map((op) => op.correlationId));
  try {
    for (const remote of await heldElsewhere()) if (!mine.has(remote.correlationId)) waiting.push(remote);
  } catch (error) {
    if (complete) throw error;
    console.warn("held: the API's history is unavailable; showing this instance's held actions only", error);
  }
  return waiting;
}

/**
 * One of this agent's payments as the provider sees it now: reads only, so an approve-only copy can
 * follow a payment its executor sent. Anything that isn't provably this agent's transfer or withdrawal is refused,
 * since every agent on the API key shares one status lookup: `readStatus` refuses another agent's
 * operation, but only when the provider names one, and owner intents (an agent's creation) are no payment.
 */
export async function paymentStatus(correlationId: string, waitMs?: number) {
  const s = await readStatus(correlationId, waitMs);
  if ((s.type !== "transfer" && s.type !== "withdraw") || s.agent_id !== agentId()) throw new Error("Not a payment of this agent");
  // Read-only review: reconstruct terms from the same provider approval after a browser reload.
  // A failed detail read must not erase a successfully read payment status.
  const local = readOps().find((op) => op.correlationId === correlationId);
  let request: Record<string, unknown> | null = local?.request ?? null;
  const approvalId = s.details?.approval_id ?? null;
  let expiresAt: string | null = null;
  let detailError: string | null = null;
  // Terms are rebuilt from an approval only for a transfer: a withdrawal's approval data isn't observed yet, so its terms
  // come from this copy's journal or not at all.
  if (approvalId && s.type === "transfer") {
    try {
      const approval = await api.getApproval(agentId(), approvalId, { signal: AbortSignal.timeout(10_000) });
      const data = approval.request_data;
      if (approval.approval_id !== approvalId || typeof data.to !== "string" || typeof data.token !== "string" || typeof data.amount !== "string" || !/^[1-9]\d*$/.test(data.amount) || !Number.isFinite(Date.parse(approval.expires_at)))
        throw new Error("Approval details do not identify this payment's terms");
      request = { recipient: data.to, asset: data.token, amount: data.amount, confidential: true };
      expiresAt = approval.expires_at;
    } catch { detailError = "Payment terms or approval deadline could not be read. Check again before deciding."; }
  }
  return { status: s.status, failureCode: s.failure_code ?? null, createdAt: s.created_at ?? null, updatedAt: s.updated_at ?? null,
    request, approvalId, expiresAt, detailError, evidence: paymentEvidence(s.details) };
}

/**
 * Transfers waiting for approval in the API's history, newest first, from the approval window. Held withdrawals are
 * listed from this copy's journal only: their approval data isn't observed yet, so their terms aren't rebuilt from it.
 */
async function heldElsewhere() {
  const since = Date.now() - APPROVAL_TTL_MS;
  const found = [];
  let cursor: string | undefined;
  do {
    const page = await api.getHistory(agentId(), { limit: 50, ...(cursor && { cursor }) });
    for (const entry of page.data) {
      const approvalId = (entry.details as { approval_id?: string } | null)?.approval_id;
      if (entry.type !== "transfer" || entry.status !== "PENDING_APPROVAL" || !approvalId) continue;
      const { request_data: data } = await api.getApproval(agentId(), approvalId);
      const request = { asset: data.token, amount: data.amount, recipient: data.to, confidential: true };
      found.push({ at: entry.created_at, kind: "remote", request, correlationId: entry.correlation_id, approvalId });
    }
    const oldest = page.data.at(-1)?.created_at;
    cursor = page.next_cursor && oldest && Date.parse(oldest) > since ? page.next_cursor : undefined;
  } while (cursor);
  return found;
}

/** Recent held-payout identities retained by the provider, including settled payouts.
 * Bounded discovery is explicitly incomplete at the page limit; no signing or journal writes.
 */
export async function paymentHistory() {
  const since = Date.now() - APPROVAL_TTL_MS;
  const items = new Map<string, { correlationId: string; at: string }>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
    const page = await api.getHistory(agentId(), { limit: 50, ...(cursor && { cursor }) }, { signal: AbortSignal.timeout(10_000) });
    for (const entry of page.data) {
      if (entry.agent_id !== agentId() || (entry.type !== "transfer" && entry.type !== "withdraw") || !entry.details?.approval_id || !(Date.parse(entry.created_at) >= since)) continue;
      items.set(entry.correlation_id, { correlationId: entry.correlation_id, at: entry.created_at });
    }
    if (!page.next_cursor) return { items: [...items.values()], complete: true };
    if (cursors.has(page.next_cursor)) break;
    cursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  return { items: [...items.values()], complete: false };
}
