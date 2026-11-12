import { api } from "../api.js";
import { agentId } from "../env.js";
import { appendOrderObservation, loadOrderProposal, orderProposalIds, readOrderObservations, readOrderPlacement,
  type OrderProviderView } from "./store.js";

const CLOSED = new Set(["filled", "canceled", "expired"]);
const KNOWN = new Set(["awaiting_deposit", "pending_cancel", "untriggered", "open", "partially_filled", ...CLOSED]);

/** A closed order with completed payouts is the only state we treat as safely finished. */
export function orderFinality(view: OrderProviderView): "complete" | "failed" | "open" | "unknown" {
  if (!view.fill_status || !KNOWN.has(view.fill_status) || !view.payout_status ||
    !["not_started", "in_progress", "completed", "failed"].includes(view.payout_status) ||
    typeof view.is_payout_status_final !== "boolean") return "unknown";
  if (!CLOSED.has(view.fill_status) || !view.is_payout_status_final) return "open";
  return view.payout_status === "completed" ? "complete" : view.payout_status === "failed" ? "failed" : "unknown";
}

/** Read a tracked order live, bind it to the placement and signed terms, then retain the full provider view. */
export async function refreshTrackedOrder(id: string) {
  const proposal = loadOrderProposal(id);
  const placed = readOrderPlacement(id);
  if (!proposal || !placed) throw new Error(`Limit order ${id} has no placement evidence`);
  const view = await api.getLimitOrder(agentId(), placed.orderId);
  if (view.order_id !== placed.orderId ||
    view.base_asset !== undefined && view.base_asset !== proposal.record.order.base_asset ||
    view.quote_asset !== undefined && view.quote_asset !== proposal.record.order.quote_asset ||
    view.side !== undefined && view.side !== proposal.record.order.side ||
    view.quantity !== undefined && view.quantity !== proposal.record.order.quantity ||
    view.price !== undefined && view.price !== proposal.record.order.price)
    throw new Error(`Provider returned limit order ${id} with different identity or terms`);
  appendOrderObservation(id, view);
  return view;
}

/** Last durable observation, which may be stale; callers needing current finality refresh first. */
export function latestOrderObservation(id: string) {
  return readOrderObservations(id).at(-1)?.view ?? null;
}

/** Poll each tracked order until both its fill and payout are final; unreadable ones remain open. */
export async function refreshOpenOrders() {
  const results: { id: string; finality: ReturnType<typeof orderFinality> | "unreadable" }[] = [];
  for (const id of orderProposalIds()) {
    if (!readOrderPlacement(id)) continue;
    const latest = latestOrderObservation(id);
    if (latest && orderFinality(latest) === "complete") continue;
    try { results.push({ id, finality: orderFinality(await refreshTrackedOrder(id)) }); }
    catch { results.push({ id, finality: "unreadable" }); }
  }
  return results;
}

/**
 * Release also checks orders listed outside this platform. The provider's list can lag, so
 * this cannot prove the absence of an externally placed order omitted from a page. Each listed
 * ID is read live; unknown pagination, identities or finality refuse release.
 */
export async function allProviderOrdersComplete() {
  const pageSize = 50;
  for (let offset = 0; offset <= 1_000; offset += pageSize) {
    const page = await api.listLimitOrders(agentId(), { limit: pageSize, offset });
    if (!Array.isArray(page.data) || page.data.length > pageSize) return false;
    for (const row of page.data) {
      if (!row.order_id) return false;
      const live = await api.getLimitOrder(agentId(), row.order_id);
      if (live.order_id !== row.order_id || orderFinality(live) !== "complete") return false;
    }
    if (page.data.length < pageSize) return true;
  }
  return false;
}
