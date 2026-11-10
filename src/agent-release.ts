import { z } from "zod";
import { api } from "./api.js";
import { agentId, executes, saveEnv } from "./env.js";
import { acquireMoneyLock, assertMoneyLock } from "./lock.js";
import { blocksDispatch, isHeld, readOps } from "./ops.js";
import { ownerActions, withOwnerLock } from "./owner-intents.js";
import { releaseMarker } from "./release-state.js";
import { configuredArea } from "./area.js";
import { mainnet, contractOf } from "./chain.js";
import { AccountDoesNotExistError, Near } from "near-kit";
import { paymentKey } from "./market/payment-key.js";
import { ASSETS } from "./policy.js";
import { releaseBalance, releaseCheckOutput, releaseRefusal } from "./contract/agent-release.js";

const view = z.object({ near_account_id: z.string().min(1), source: z.enum(["public", "confidential"]), balances: z.array(z.object({ asset_id: z.string(), balance_raw: z.string().regex(/^[0-9]+$/) })) });
const near = new Near(mainnet);
/** Supported payment-key holdings: native NEAR (including locked storage) and USDC. Unknown reads refuse release. */
export async function paymentKeyBalances(): Promise<z.output<typeof releaseBalance>[]> {
  const account = paymentKey().account;
  const native = await near.rpc.getAccount(account).then(r => BigInt(r.amount) + BigInt(r.locked), (e: unknown) => {
    if (e instanceof AccountDoesNotExistError) return 0n; throw e;
  });
  const usdc = await near.view<unknown>(contractOf(ASSETS.USDC), "ft_balance_of", { account_id: account });
  if (typeof usdc !== "string" || !/^[0-9]+$/.test(usdc)) throw new Error("The payment key's balance couldn't be read");
  return [{ source: "payment-key", asset: "near", amount: native.toString() }, { source: "payment-key", asset: ASSETS.USDC, amount: usdc }];
}
/** No send. Own both locks, so neither a dispatch nor a prepared/signed owner action can race the marker. */
export function prepareRelease(input: { agentId: string; owner: string; allowBalance?: boolean }, keyBalances = paymentKeyBalances) {
  return withOwnerLock(async (assertOwnerCurrent): Promise<z.output<typeof releaseCheckOutput>> => {
    const refused = (reason: z.output<typeof releaseRefusal>["reason"],
      balances: z.output<typeof releaseBalance>[] = []) => ({ state: "refused" as const, reason, balances });
    if (!executes()) return refused("not_executor");
    if (agentId() !== input.agentId) return refused("owner_changed");
    const marked = releaseMarker();
    if (marked) return { state: "prepared", agentId: agentId(), ...marked };
    const lock = await acquireMoneyLock({ reconcile: true });
    try {
      const [agent, policy, open, confidential] = await Promise.all([api.getAgent(agentId()), api.getPolicy(agentId()),
        api.getBalances(agentId(), { source: "public" }), api.getBalances(agentId(), { source: "confidential" })]);
      if (agent.id !== input.agentId || agent.owner?.type !== "near" || agent.owner.account_id !== input.owner) return refused("owner_changed");
      const wallet = agent.wallet;
      if (!wallet?.wallet_id || !wallet.near_account_id || policy.wallet_id !== wallet.wallet_id) return refused("owner_changed");
      if (agent.status !== "ARCHIVED") return refused("not_archived");
      if (policy.policy?.frozen !== true) return refused("not_frozen");
      const ops = readOps();
      if (ops.some(blocksDispatch)) return refused("unresolved");
      if (ops.some(isHeld)) return refused("held");
      const actions = ownerActions();
      if (actions.some(a => a.phase === "open" || a.phase === "submitted")) return refused("owner_action");
      const balances: z.output<typeof releaseBalance>[] = [];
      for (const [source, raw] of [["public", open], ["confidential", confidential]] as const) {
        const read = view.parse(raw);
        if (read.source !== source || read.near_account_id !== wallet.near_account_id) return refused("owner_changed");
        for (const b of read.balances) if (BigInt(b.balance_raw) > 0n) balances.push({ source, asset: b.asset_id, amount: b.balance_raw });
      }
      if (configuredArea(process.env.DASHBOARD_AREA) === "market") balances.push(...(await keyBalances()).filter(b => BigInt(b.amount) > 0n));
      if (balances.length && !input.allowBalance) return refused("balance", balances);
      assertMoneyLock(lock);
      assertOwnerCurrent();
      const at = new Date().toISOString();
      const archiveCorrelationId = actions.find(a => a.type === "agent_archive" && a.status === "SUCCESS")?.correlationId ?? null;
      saveEnv({ RELEASED_AT: at, RELEASED_ARCHIVE: archiveCorrelationId ?? "", AUTOPILOT: "off" });
      return { state: "prepared", agentId: agentId(), at, archiveCorrelationId };
    } finally { await lock.release(); }
  });
}
