import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Near } from "near-kit";
import { api } from "../api.js";
import { marketHireCapRefusal } from "../authorize.js";
import { mainnet, contractOf } from "../chain.js";
import { agentId, ENV_FILE, executes } from "../env.js";
import { allocationReservations } from "./allocation-reservation.js";
import { acquireMoneyLock, assertMoneyLock } from "../lock.js";
import { mandateDigest } from "../mandate.js";
import { isResolved, marketStageKey, readMarketBindings, readOps, recordMarketAllocation, type MarketBinding } from "../ops.js";
import { PublicError } from "../public-error.js";
import { assertCanSendAfterRelease } from "../release-state.js";
import { ASSETS } from "../policy.js";
import { hasUnprovenMarketFunding, legacyMarketFunding } from "./binding-guard.js";
import { allocationText, parseAllocation, type AllocationMessage, type SignedAllocation } from "./allocation-types.js";
import { fundingProof } from "./funding-proof.js";
import { paymentKey } from "./payment-key.js";
import { readChainView } from "./resolution.js";

const near = new Near(mainnet);
const refuse = (message: string): never => { throw new PublicError(`Market allocation refused: ${message}`); };

/** No fallback host: the stopped-executor rollout must explicitly pin the signing domain in hosted settings. */
function localIdentity(m: AllocationMessage) {
  assertCanSendAfterRelease();
  if (!executes()) refuse("only the canonical executor can record or use an allocation");
  if (!process.env.MARKET_ALLOCATION_HOST || m.host !== process.env.MARKET_ALLOCATION_HOST ||
      m.providerOrigin !== new URL(process.env.NEAR_INTENTS_AGENT_API_URL ?? "https://api.demo.agentsonintents.com").origin ||
      m.agentId !== agentId()) refuse("host, provider or agent changed");
  const key = paymentKey();
  if (key.account !== m.paymentAccount || key.publicKey !== m.paymentPublicKey) refuse("payment key changed");
  const entry = allocationReservations(join(realpathSync(process.cwd()), ".hosted"))
    .filter(e => realpathSync(e.envFile) === realpathSync(ENV_FILE));
  if (entry.length !== 1 || entry[0]!.kind !== "wallet" || entry[0]!.area !== "market" || entry[0]!.owner !== m.ownerAccount ||
      process.env.HOSTED_OWNER_KIND === "dao" || process.env.TREASURY_ACCOUNT) refuse("durable wallet-owner reservation required");
}

async function currentAuthority(m: AllocationMessage) {
  localIdentity(m);
  if (Date.parse(m.expiresAt) <= Date.now() || Date.parse(m.expiresAt) > Date.now() + 3_600_000) refuse("owner authorization expired or outside its one-hour window");
  const [agent, policy, key] = await Promise.all([api.getAgent(m.agentId), api.getPolicy(m.agentId),
    near.rpc.getAccessKey(m.ownerAccount, m.ownerPublicKey)]);
  localIdentity(m);
  if (agent.id !== m.agentId || agent.status !== "ACTIVE" || agent.archived || agent.deleted ||
      agent.owner?.type !== "near" || agent.owner.account_id !== m.ownerAccount || key.permission !== "FullAccess") refuse("current wallet owner/key unavailable");
  if (!policy.policy || policy.policy.frozen || policy.status !== "APPLIED" || !policy.provider_policy_synced ||
      policy.revision !== m.reviewedPolicy.revision || mandateDigest(policy.policy) !== m.reviewedPolicy.digest) refuse("reviewed policy changed");
  const cap = marketHireCapRefusal(m.target.approved, policy.policy!);
  if (cap) refuse(cap.message);
  if (Date.parse(m.expiresAt) <= Date.now()) refuse("authorization expired during reads");
}

/** Fresh authority for an allocated hire, called before every top-up/payment at the final dispatch boundary. */
export async function assertAllocationCurrent(binding: MarketBinding): Promise<AllocationMessage | null> {
  if (!binding.fundingSource) return null;
  const m = parseAllocation(binding.fundingSource);
  if (m.target.actor !== binding.actor || m.target.requestId !== binding.requestId) refuse("target identity changed");
  await currentAuthority(m);
  return m;
}

/** Preparation and admission re-prove original receipts; balances alone never release a reservation. */
async function sourceEvidence(m: AllocationMessage) {
  await currentAuthority(m);
  const bindings = readMarketBindings(), ops = readOps();
  const source = bindings.find(b => b.idempotencyKey === m.sourceBindingKey);
  if (!source?.fundingOnly || source.refused || !source.landed.open || !source.landed.usdc ||
      source.paymentAccount !== m.paymentAccount || source.publicKey !== m.paymentPublicKey ||
      source.approved.amount !== m.sourceUsdcAmount || m.target.approved.asset !== contractOf(ASSETS.USDC) ||
      m.target.approved.network !== "near:mainnet") refuse("fully proven isolated source required");
  if (legacyMarketFunding(m.paymentAccount) || hasUnprovenMarketFunding(ops, bindings) || ops.some(o => !isResolved(o))) refuse("unresolved or legacy funding exists");
  let expected = BigInt(m.sourceUsdcAmount), maximumHeight = 0n;
  for (const binding of bindings.filter(b => b === source || source!.allocation && b.fundingSource?.message === source!.allocation.message)) {
    for (const stage of ["open", "usdc"] as const) {
      const landing = binding.landed[stage];
      if (!landing) continue;
      const op = ops.find(o => o.idempotencyKey === marketStageKey(binding.idempotencyKey, stage));
      if (!op?.correlationId || op.status !== "SUCCESS") refuse("original submitted operation missing");
      const status = await api.getStatus(op!.correlationId!);
      const details = status.details as { amount_out?: string; destination_tx_hash?: string; request?: Record<string, unknown> } | undefined;
      if (status.agent_id !== m.agentId || status.type !== "withdraw" || status.status !== "SUCCESS" ||
          !details?.amount_out || details.destination_tx_hash !== landing.destinationTxHash ||
          !details.request || ["asset", "amount", "chain", "recipient", "confidential"].some(k => details.request![k] !== op!.request[k])) refuse("original provider request or receipt mismatch");
      const proof = await fundingProof.verify({ destinationTxHash: details!.destination_tx_hash, recipient: m.paymentAccount,
        asset: stage === "open" ? ASSETS.wNEAR : ASSETS.USDC, amount: details!.amount_out! });
      if (!proof || proof.blockHeight !== landing.finalHeight) refuse("original final receipt is unavailable");
      maximumHeight = BigInt(proof!.blockHeight) > maximumHeight ? BigInt(proof!.blockHeight) : maximumHeight;
      if (binding === source && stage === "usdc" && proof!.amount !== m.sourceUsdcAmount) refuse("initial version requires full-delivery source");
      if (binding !== source && stage === "usdc") expected += BigInt(proof!.amount);
    }
  }
  const view = await readChainView(m.paymentAccount, m.paymentPublicKey, contractOf(ASSETS.USDC));
  if (view.height < maximumHeight || view.balance !== expected || view.keyNonce !== 0n) refuse("balance, nonce or later final view differs");
  if (JSON.stringify(source!.landed.open) !== JSON.stringify(m.sourceOpen) || JSON.stringify(source!.landed.usdc) !== JSON.stringify(m.sourceUsdc)) refuse("signed source references changed");
  await currentAuthority(m);
}

export async function prepareMarketAllocation(input: Omit<AllocationMessage, "domain" | "nonce">) {
  const message: AllocationMessage = { domain: "multiagency.market-funding-disposition.v1", ...input, nonce: randomBytes(32).toString("base64") };
  const text = allocationText(message);
  if (Date.parse(message.expiresAt) > Date.now() + 3_600_000) refuse("authorization window exceeds one hour");
  const lock = await acquireMoneyLock();
  try { await sourceEvidence(message); assertMoneyLock(lock); return { message: text, nonce: message.nonce, recipient: message.host }; }
  finally { await lock.release(); }
}

export async function commitMarketAllocation(signed: SignedAllocation) {
  const m = parseAllocation(signed);
  if (Date.parse(m.expiresAt) > Date.now() + 3_600_000) refuse("authorization window exceeds one hour");
  const lock = await acquireMoneyLock();
  try {
    await sourceEvidence(m);
    assertMoneyLock(lock);
    // Recheck expiry after all remote reads; no await before the single durable allocation record.
    if (Date.parse(m.expiresAt) <= Date.now()) refuse("authorization expired before recording");
    recordMarketAllocation(signed);
    return { recorded: true, sends: 0 as const };
  } finally { await lock.release(); }
}
