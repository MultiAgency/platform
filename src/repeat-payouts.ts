import { api } from "./api.js";
import { agentId } from "./env.js";

/**
 * Earlier payouts of the same payee, asset and amount, for an owner's vote on a held payout. A second payment of one
 * invoice under a new requestId reaches the owner as a new payout (docs/crash-test.md); this puts the first beside it.
 * It informs the owner and refuses nothing: a recurring payment has the same terms too.
 *
 * Read from the provider's history, so payouts any instance or caller sent count, over the last 24 hours (the window a
 * held payout can wait for its vote). Settled, released, held and failed payouts count, each with its status (a provider
 * FAILED isn't proof nothing moved); a refund doesn't. A history that can't be read whole answers `{ checked: false }`,
 * never an empty list.
 */
export const REPEAT_WINDOW_MS = 24 * 60 * 60_000;
const PAGES = 5, APPROVAL_READS = 20;

export type PayoutTerms = { recipient: string; asset: string; amount: string; chain?: "near" };
export type Repeats = { checked: true; payouts: { correlationId: string; at: string; status: string }[] } | { checked: false };

export async function repeatPayouts(terms: PayoutTerms, correlationId: string, now = Date.now()): Promise<Repeats> {
  const since = now - REPEAT_WINDOW_MS, flow = terms.chain === "near" ? "withdraw" : "transfer";
  const payouts: { correlationId: string; at: string; status: string }[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined, approvalReads = 0;
  try {
    for (let page = 0; page < PAGES; page++) {
      const answer = await api.getHistory(agentId(), { limit: 50, ...(cursor && { cursor }) }, { signal: AbortSignal.timeout(10_000) });
      for (const entry of answer.data) {
        // Agents on one API key share history reads that name an agent: count only this agent's.
        if (entry.agent_id !== agentId() || entry.type !== flow || entry.correlation_id === correlationId || entry.status === "REFUNDED") continue;
        if (!(Date.parse(entry.created_at) >= since)) continue;
        const details = entry.details as { request?: Record<string, unknown>; approval_id?: string | null };
        let seen = details.request && typeof details.request.recipient === "string" && typeof details.request.asset === "string" &&
          typeof details.request.amount === "string" ? { recipient: details.request.recipient, asset: details.request.asset, amount: details.request.amount } : null;
        if (!seen) {
          // Without terms in the entry, its approval names them; an entry with neither can't be compared.
          if (!details.approval_id || ++approvalReads > APPROVAL_READS) return { checked: false };
          const data = (await api.getApproval(agentId(), details.approval_id, { signal: AbortSignal.timeout(10_000) })).request_data as Record<string, unknown> | undefined;
          if (typeof data?.to !== "string" || typeof data.token !== "string" || typeof data.amount !== "string") return { checked: false };
          seen = { recipient: data.to, asset: data.token, amount: data.amount };
        }
        if (seen.recipient === terms.recipient && seen.asset === terms.asset && seen.amount === terms.amount)
          payouts.push({ correlationId: entry.correlation_id, at: entry.created_at, status: entry.status });
      }
      const oldest = answer.data.at(-1)?.created_at;
      if (!answer.next_cursor || (oldest && Date.parse(oldest) < since)) return { checked: true, payouts };
      if (cursors.has(answer.next_cursor)) return { checked: false };
      cursors.add(answer.next_cursor);
      cursor = answer.next_cursor;
    }
    // The window reached past the pages read: what wasn't read could hold a repeat.
    return { checked: false };
  } catch {
    return { checked: false };
  }
}
