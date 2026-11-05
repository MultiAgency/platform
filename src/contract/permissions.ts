/**
 * The procedure→permission map, as data. Single source: the gateway enforces with this same module
 * (src/gateway/allowlist.ts); apps may mirror it to present controls, but presenting never authorizes.
 */
/** What an admitted account may do with an agent (resolved by the gateway from ownership and DAO roles). */
export type Access = { canSign: boolean; canPropose: boolean; canVote: boolean; canExecute: boolean; canManage: boolean };
/**
 * Agent-server procedures by capability, shared with the dashboard. Unknown paths are denied even
 * to wallet owners. These controls do not replace the provider's policy, grant or owner signature.
 */
export const READS = new Set([
  "setup",
  "instance",
  "account",
  "overview",
  "policyHistory",
  "treasury/get",
  "activity",
  "unresolved",
  "held",
  "autopilot/get",
  "strategy/get",
  "autopilot/evidence",
  "autopilot/log",
  "inbox/list",
  "ledger",
  "ledgerCsv",
  "reconcileBooks",
  "owner/status",
  "owner/pending",
  "owner/actions",
  "paymentHistory",
  "paymentStatus",
  "payouts/status",
  "agreements/list",
  "invoices",
  "compensation/list",
  "workOrders/list",
  "workOrders/get",
  "workOrders/status",
  "demoGuide/compose",
  "proposals/get",
  "proposals/list",
]);

export const OWNER_PROPOSALS = new Set([
  "owner/prepare",
  "agreements/propose",
  "agreements/offer",
  "workOrders/create",
  "workOrders/prepare",
]);
const PREPARE = new Set([...OWNER_PROPOSALS, "rebalance", "externalPlan", "steward/propose", "deposit", "treasury/fund", "workOrders/deposit", "proposals/create", "proposals/withdraw"]);
const EXECUTE = new Set(["proposals/execute", "workOrders/file", "compensation/prepare", "compensation/send", "compensation/review", "pay", "payouts/request", "sweep", "executePlan", "autopilot/tick", "autopilot/enable"]);
const MANAGE = new Set(["compensation/agreement", "strategy/save", "treasury/link", "treasury/unlink", "treasury/setConfidential", "agreements/decline"]);
const MAINTAIN = new Set(["autopilot/stop", "recover", "inbox/dismiss", "cancelPreparedInvoice"]);

/** Whether this admitted account may call `path` (`owner/prepare`, without the `/rpc/` prefix). */
export function mayCall(access: Access, path: string): boolean {
  if (READS.has(path)) return true;
  if (PREPARE.has(path)) return access.canSign || access.canPropose;
  // The owner's signature over a proposal's text is what the agent checks; relaying it is a signer's call.
  if (path === "owner/submit" || path === "workOrders/submit" || path === "proposals/approve" || path === "proposals/reject") return access.canSign;
  if (EXECUTE.has(path)) return access.canExecute;
  if (MANAGE.has(path)) return access.canManage;
  if (path === "autopilot/set") return access.canManage && access.canExecute;
  if (MAINTAIN.has(path)) return access.canManage || access.canExecute;
  return false;
}

