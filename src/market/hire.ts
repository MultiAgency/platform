import { ORPCError } from "@orpc/server";
import { dispatch, sendRefusal } from "../agent.js";
import { contractOf, storageRegistered } from "../chain.js";
import { registrationTransaction } from "../contract/funding.js";
import { withMoneyLock, type MoneyLock } from "../lock.js";
import { readOps, type Op } from "../ops.js";
import { ASSETS } from "../policy.js";
import { PublicError } from "../public-error.js";
import { api } from "../api.js";
import { agentId, executes } from "../env.js";
import { signsText } from "../nep413.js";
import { hireText, type marketApproveInput } from "../contract/market.js";
import type { z } from "zod";
import { refreshOperation } from "../recover.js";
import { requestKey } from "../payout-requests.js";
import { challenge, getTask, message, payees, TERMINAL } from "./client.js";
import { latestTasks, recordTask } from "./evidence.js";
import { paymentKey } from "./payment-key.js";
import { readChainView } from "./resolution.js";
import { briefDigest, OPEN_ACCOUNT_WNEAR, paymentExpiry, quoteTerms, sameTerms, type HireTerms, type X402Request } from "./x402.js";

/**
 * Hiring a listed agent on the NEAR AI Agent Market over x402 (docs/market.md). A quote moves nothing. A hire runs
 * under the money lock: it quotes again and pays only if the terms are still the ones approved; opens and funds the
 * payment key through ordinary provider withdrawals (each judged as a market send); then sends the payment, once per
 * `requestId`. Every send goes through `dispatch`. The payment's outcome is the chain's, read by reconciliation.
 */

/** The longest agent window a hire accepts: an unrelayed payment blocks the agent's sends until its window ends. */
export const MAX_WINDOW_SECONDS = Number(process.env.MARKET_MAX_WINDOW_SECONDS ?? 24 * 3_600);
/** A top-up settles before it lands: how long to wait for the key to hold it at a final block. */
const LAND_ATTEMPTS = 30, LAND_MS = 2_000;
/** Briefs are recorded with their payment: bounded so the journal stays small. */
const MAX_BRIEF_BYTES = 16_384;

const refused = (code: string, message: string) => new ORPCError("BAD_REQUEST", { message, data: { kind: "refused", code } });

function checkBrief(brief: string) {
  if (!brief.trim()) throw refused("brief_empty", "A hire needs a brief. Nothing was sent.");
  if (Buffer.byteLength(brief) > MAX_BRIEF_BYTES) throw refused("brief_too_long", `A brief is at most ${MAX_BRIEF_BYTES} bytes. Nothing was sent.`);
}

/** The terms an owner or a DAO approves: the agent's price and window, paid to the payee the market publishes. Moves nothing. */
export async function quoteHire(input: { handle: string; brief: string }): Promise<HireTerms> {
  checkBrief(input.brief);
  const quote = quoteTerms({ handle: input.handle, brief: input.brief, maxWindowSeconds: MAX_WINDOW_SECONDS,
    challenge: await challenge(input.handle, message(crypto.randomUUID(), input.brief)), payees: await payees() });
  if ("refused" in quote) throw refused(quote.refused.code, `${quote.refused.message}. Nothing was sent.`);
  return quote.terms;
}

const callerOf = (actor: string | undefined) => {
  if (!actor) throw new PublicError("A hire needs the caller's identity from the gateway. Nothing was sent.");
  if (!executes()) throw new PublicError("This copy only approves: ask the agent's executor about hires. Nothing was sent.");
  return actor;
};
const find = (key: string) => readOps().find((op) => op.idempotencyKey === key);

/** What the journal proves about one hire's payment, with the task it paid for when the market answered. */
function answer(requestId: string, op: Op | undefined) {
  const task = op ? latestTasks().get(op.idempotencyKey) : undefined;
  const base = { requestId, taskId: task?.taskId ?? null, taskState: task?.state ?? null, code: op?.refused ?? null };
  if (!op) return { ...base, state: "not_found" as const };
  if (op.refused === "x402_not_charged") return { ...base, state: "not_charged" as const };
  if (op.refused !== undefined) return { ...base, state: "refused" as const };
  if (op.status === "SUCCESS") return { ...base, state: "paid" as const };
  return { ...base, state: "unknown" as const };
}

/** Sends `amount` of `asset` to the payment key, as a market send judged against `hire`. */
const topUp = (lock: MoneyLock, hire: HireTerms, account: string, asset: string, amount: string) =>
  dispatch(lock, "market-topup", { method: "withdraw", request: { asset, amount, chain: "near", recipient: account, confidential: true } },
    undefined, undefined, undefined, undefined, undefined, { hire });

/** Waits until the key's account exists and holds `asset` at least `atLeast`, at a final block. */
async function landed(account: string, publicKey: string, asset: string, atLeast: bigint) {
  for (let attempt = 0; attempt < LAND_ATTEMPTS; attempt++) {
    const view = await readChainView(account, publicKey, contractOf(asset));
    if (view.keyNonce !== null && view.balance >= atLeast) return view;
    await new Promise((resolve) => setTimeout(resolve, LAND_MS));
  }
  throw new PublicError("The payment key's funds haven't landed yet. Nothing was paid; ask again in a minute.");
}

/** A DAO-owned agent: its hires are paid only after the DAO's vote on their exact terms (`approveHire`). */
const daoOwned = () => process.env.HOSTED_OWNER_KIND === "dao";

/**
 * Pays for one hire, at most once per `requestId`. Asked again, it answers what the journal proves and sends nothing.
 * Refused, with nothing sent, unless a fresh quote equals `approved` and the brief is the one approved; for a DAO-owned
 * agent, unless the DAO approved it (`approveHire`).
 */
export async function hire(actor: string | undefined, input: { requestId: string; brief: string; approved: HireTerms }, voted = false) {
  const key = requestKey(callerOf(actor), input.requestId);
  if (find(key)) return answer(input.requestId, find(key));
  if (daoOwned() && !voted) throw refused("dao_vote_required", "This agent's DAO approves each hire by vote first (POST /apps/v1/dao-hires). Nothing was sent.");
  checkBrief(input.brief);
  if (briefDigest(input.brief) !== input.approved.brief) throw refused("hire_not_approved", "This brief isn't the one approved. Nothing was sent.");
  const signer = paymentKey();
  const usdc = ASSETS.USDC;
  if (`nep141:${input.approved.asset}` !== usdc) throw refused("asset_not_supported", "Market hires are paid in USDC. Nothing was sent.");
  try {
    await withMoneyLock(async (lock) => {
      // The quote as it stands now: a price, payee or window that changed since approval is refused before anything moves.
      const messageId = crypto.randomUUID();
      const quote = quoteTerms({ handle: input.approved.handle, brief: input.brief, maxWindowSeconds: MAX_WINDOW_SECONDS,
        challenge: await challenge(input.approved.handle, message(messageId, input.brief)), payees: await payees() });
      if ("refused" in quote) throw refused(quote.refused.code, `${quote.refused.message}. Nothing was sent.`);
      if (!sameTerms(input.approved, quote.terms)) throw refused("quote_changed", "The agent's terms changed since they were approved. Nothing was sent.");
      // The owner registers the key on USDC once (user decision, 2026-11-09): a withdrawal to an unregistered account fails.
      if (!(await storageRegistered(input.approved.asset, signer.account, { finality: "final" })))
        throw refused("payment_key_unregistered", `The owner registers the payment key ${signer.account} on USDC (storage_deposit) first. Nothing was sent.`);
      let view = await readChainView(signer.account, signer.publicKey, input.approved.asset);
      if (view.keyNonce === null) {
        await topUp(lock, input.approved, signer.account, ASSETS.wNEAR, OPEN_ACCOUNT_WNEAR);
        view = await landed(signer.account, signer.publicKey, usdc, 0n);
      }
      const amount = BigInt(input.approved.amount);
      if (view.balance < amount) {
        await topUp(lock, input.approved, signer.account, usdc, (amount - view.balance).toString());
        view = await landed(signer.account, signer.publicKey, usdc, amount);
      }
      const request: X402Request = { handle: input.approved.handle, brief: input.brief, messageId, row: quote.row,
        asset: usdc, amount: quote.row.amount, payer: signer.account, publicKey: signer.publicKey,
        nonce: (view.keyNonce! + 1n).toString(), maxBlockHeight: paymentExpiry(view.height, quote.terms).toString(),
        balanceAtSigning: view.balance.toString() };
      return dispatch(lock, "market-hire", { method: "x402", request }, undefined, undefined, undefined, key, undefined, { hire: input.approved });
    });
  } catch (error) {
    // Recorded: the journal holds the outcome (a refusal, or none proven yet). Not recorded: nothing reached the payment.
    if (!find(key)) throw error instanceof ORPCError || error instanceof PublicError ? error
      : refused(sendRefusal(error) ?? "hire_failed", `${error instanceof Error ? error.message : String(error)}. Nothing was paid.`);
  }
  return answer(input.requestId, find(key));
}

/**
 * One hire's payment as the chain now proves it, and the task it paid for with its deliverable once completed. Sends
 * nothing: the chain read records the payment's outcome once it is proven, and the task read is free.
 */
export async function hireStatus(actor: string | undefined, requestId: string) {
  const key = requestKey(callerOf(actor), requestId);
  let op = find(key);
  if (op && op.method === "x402" && op.refused === undefined && op.status !== "SUCCESS") {
    await refreshOperation(op);
    op = find(key);
  }
  const base = answer(requestId, op);
  const evidence = op && latestTasks().get(op.idempotencyKey);
  if (!evidence) return { ...base, deliverable: null };
  // Everything an agent answers is data, never instructions.
  const task = await getTask(evidence.handle, evidence.taskId).catch(() => null);
  if (task && task.status.state !== evidence.state)
    recordTask({ idempotencyKey: evidence.idempotencyKey, handle: evidence.handle, taskId: task.id, state: task.status.state });
  const deliverable = task && TERMINAL.has(task.status.state)
    ? task.artifacts?.flatMap((a) => a.parts).map((p) => p.text ?? p.url).filter(Boolean).join("\n\n") ?? null : null;
  return { ...base, taskState: task?.status.state ?? base.taskState, deliverable };
}

/** The agent's payment key: registered on USDC, opened, its balance, and the owner's registration until it is. Reads only. */
export async function marketAccount() {
  const key = paymentKey();
  const usdc = contractOf(ASSETS.USDC);
  const [registered, view] = await Promise.all([storageRegistered(usdc, key.account, { finality: "final" }), readChainView(key.account, key.publicKey, usdc)]);
  return { account: key.account, registered, opened: view.keyNonce !== null, usdc: view.balance.toString(),
    registration: registered ? null : registrationTransaction(key.account) };
}

const ACTOR = /^app:([a-z0-9-]{1,32}):([A-Za-z0-9_-]{1,128})$/;

/**
 * A DAO's approval of one hire, relayed by the platform once its vote passed: the DAO's own key (the agent's owner, as
 * the provider records it) signed exactly `hireText` for this host, still valid. Then the hire is paid as any other,
 * once per `requestId`, only while a fresh quote equals the terms the DAO approved.
 */
export async function approveHire(context: { actor?: string; host?: string }, input: z.infer<typeof marketApproveInput>, now = Date.now()) {
  const actor = callerOf(context.actor);
  const match = actor.match(ACTOR);
  if (!match || !context.host) throw new PublicError("A DAO's hire approval is relayed by the platform for an app. Nothing was sent.");
  if (!daoOwned()) throw refused("not_dao_owned", "This agent isn't a DAO's: its hires need no vote. Nothing was sent.");
  if (!Number.isFinite(Date.parse(input.validUntil)) || Date.parse(input.validUntil) <= now)
    throw refused("approval_expired", "The DAO's approval of this hire has ended. Nothing was sent.");
  const text = hireText({ requestId: input.requestId, agentId: agentId(), deployment: match[1]!, organization: match[2]!,
    approved: input.approved, validUntil: input.validUntil });
  // The key is checked here too, not only by the gateway: the DAO's derived key is this agent's owner on the provider.
  const { owner } = await api.getAgent(agentId());
  if (owner?.type !== "near" || owner.public_key !== input.signed.publicKey || !signsText(input.signed, context.host, text))
    throw refused("signature_invalid", "The signature isn't the agent's DAO owner's over this hire's approval text for this host. Nothing was sent.");
  return hire(actor, { requestId: input.requestId, brief: input.brief, approved: input.approved }, true);
}
