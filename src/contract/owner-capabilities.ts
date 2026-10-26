/**
 * Owner-app capabilities (P2 manifest v1): what an owner frontend may declare in `contract.json`.
 * A capability names existing routes so the gateway can refuse a release this platform cannot serve.
 * It grants nothing: every call is still authorized per session, agent and procedure.
 */
export const ownerCapabilities = {
  "gateway-session-v1": { routes: ["/gw/challenge", "/gw/session", "/gw/logout", "/gw/me", "/gw/agents", "/a/<agent>/access"], procedures: [] },
  "agent-observe-v1": { routes: [], procedures: ["setup", "instance", "overview", "summary", "policyHistory", "activity", "unresolved", "held", "autopilot/get", "inbox/list", "inbox/dismiss"] },
  /** A safety control: stopping a running schedule stays reachable on every host that can run one. */
  "agent-schedule-stop-v1": { routes: [], procedures: ["autopilot/stop"] },
  "agent-funding-v1": { routes: [], procedures: ["deposit"] },
  /** The owning DAO link, funding from it, shielding and sweep: any agent, not only Treasury strategy. */
  "owner-treasury-v1": { routes: [], procedures: ["treasury/get", "treasury/link", "treasury/unlink", "treasury/setConfidential", "treasury/fund", "sweep"] },
  "owner-intents-v1": { routes: ["/gw/proposals", "/gw/interventions"], procedures: ["owner/prepare", "owner/submit", "owner/status", "owner/pending", "owner/actions"] },
  "treasury-observe-v1": { routes: [], procedures: ["strategy/get", "autopilot/evidence", "autopilot/log", "ledger", "ledgerCsv", "reconcileBooks"] },
  "treasury-strategy-v1": { routes: [], procedures: ["strategy/save", "autopilot/set", "autopilot/enable", "autopilot/tick"] },
  "treasury-plans-v1": { routes: [], procedures: ["rebalance", "externalPlan", "executePlan", "steward/propose"] },
  "treasury-recovery-v1": { routes: [], procedures: ["recover"] },
  "payables-payments-v1": { routes: [], procedures: ["pay", "paymentHistory", "paymentStatus", "invoices", "cancelPreparedInvoice", "ledger", "ledgerCsv", "reconcileBooks"] },
  "payables-agreements-v1": { routes: [], procedures: ["agreements/list", "agreements/propose", "agreements/offer", "agreements/decline"] },
  "payables-work-orders-v1": { routes: [], procedures: ["workOrders/list", "workOrders/get", "workOrders/status", "workOrders/create", "workOrders/prepare", "workOrders/submit", "workOrders/deposit", "workOrders/file"] },
  "payables-compensation-v1": { routes: [], procedures: ["compensation/list", "compensation/agreement", "compensation/review", "compensation/prepare", "compensation/send"] },
  "payables-recovery-v1": { routes: [], procedures: ["recover"] },
  /** Temporary: guide inference stays in Proto until its extraction (recorded migration gap). */
  "payables-guide-v1": { routes: [], procedures: ["demoGuide/compose"] },
} as const satisfies Record<string, { routes: readonly string[]; procedures: readonly string[] }>;
export type OwnerCapability = keyof typeof ownerCapabilities;

const neutral = ["gateway-session-v1", "agent-observe-v1", "agent-schedule-stop-v1", "agent-funding-v1", "owner-treasury-v1", "owner-intents-v1"] as const;
/** What a host provides, from the areas of the agents assigned to it. `showcase`-only hosts get the neutral set. */
export function providedCapabilities(areas: readonly ("treasury" | "payables")[]): OwnerCapability[] {
  const names = Object.keys(ownerCapabilities) as OwnerCapability[];
  return [...neutral, ...names.filter(name => areas.some(area => name.startsWith(`${area}-`)))];
}
