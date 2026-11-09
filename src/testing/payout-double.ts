import type { Policy } from "@near-intents-agent-api/sdk";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Action } from "../agent.js";
import { agreedPayees, authorize, notInForce, WITHDRAWN, type Facts } from "../authorize.js";
import { APP_PAYOUT, APP_READS } from "../contract/app-access.js";
import type { AppBase } from "../contract/app-client.js";
import type { AppScope } from "../contract/app-consent.js";
import { ASSETS } from "../contract/assets.js";
import { payoutRequestInput, payoutStatusInput } from "../contract/inputs.js";
import { mandateDigest } from "../mandate.js";
import { isTerminal, isUnknownOutcome } from "../operation-status.js";
import { payoutFailure } from "../payout-failure.js";
import { payoutPolicy } from "../policy.js";
import type { DoubleGrant, DoubleOutcome, DoublePolicy, DoublePolicyState, DoubleRequest, PayoutDouble, PayoutDoubleFactory } from "./types.js";

/**
 * An in-process stand-in for one app's payout agent behind `/apps/v1`, for an app's own tests (`@multiagency/sdk/testing`).
 * The app passes its `fetch` to `appClient` and calls `payouts/request`, `payouts/status`, `held` and `overview` as it
 * would on the platform, through the SDK's own client and the same oRPC wire.
 *
 * What it runs from the platform, unchanged: `authorize` (the one authorization rule, src/authorize.ts), the mandate
 * digest a request's `expectedPolicy` binds, the payout policy template, and the procedures' input schemas. What it
 * restates from the platform, pinned against the real money path by test/payout-double.test.ts: the order of a
 * request's checks and the journal's answers (src/payout-requests.ts, `dispatch` in src/agent.ts), the gateway's consent
 * and scope denials, and the provider: it holds every payment for the owner when the policy says so, refuses a transfer
 * outside the agreed payees or an action the policy doesn't list under a code the platform can't prove was a refusal
 * (so the request reads `unknown`), and models no budget, hourly or monthly limit, approval expiry or provider outage.
 */

type Op = {
  requestId: string; method: "transfer" | "withdraw"; request: Record<string, string | boolean>;
  at: string; status: string | null; refused: string | null; correlationId: string | null;
};
/** The provider's shapes `authorize` reads: the double builds only the fields it judges by. */
type Provider = Pick<Facts["payout"], "view" | "grant">;
type Payment = { correlationId: string; approvalId: string; status: string; asset: string; amount: string; rejected?: boolean };

const implicit = (account: string) => /^[0-9a-f]{64}$/.test(account) || /^0x[0-9a-f]{40}$/.test(account);
const refused = (code: string, message: string) => new ORPCError("BAD_REQUEST", { message, data: { kind: "refused", code } });

export const payoutDouble: PayoutDoubleFactory = (options = {}) => {
  const organization = options.organization ?? "org_1", agent = options.agent ?? "payout";
  const base: AppBase = "https://platform.double.invalid", credential = `tap_double_${crypto.randomUUID()}`;
  const agentId = "0".repeat(63) + "1";
  let policy: DoublePolicy = structuredClone(options.policy ?? payoutPolicy(options.payees ?? ["payee.near"]) as DoublePolicy);
  let revision = 1, state: Required<DoublePolicyState> = { status: "APPLIED", synced: true };
  let grant: DoubleGrant = options.grant === undefined ? { label: "payout" } : options.grant;
  let grantExpiry = new Date(Date.now() + 86_400_000).toISOString();
  const balances = new Map(Object.entries(options.balances ?? { [ASSETS.USDC]: "100000000" }));
  const scopes = new Set<AppScope>(options.scopes ?? ["read", "payout"]);
  let consented = true, loseNext = false, chainDown = false;
  const absent = new Set<string>(), unregistered = new Set<string>();
  const journal = new Map<string, Op>(), payments = new Map<string, Payment>(), unmodelled: string[] = [];

  const view = () => ({ policy: policy as Policy, revision, wallet_id: "double-wallet", status: state.status, provider_policy_synced: state.synced,
    policy_hash: null, applied_at: null, transaction_hash: null, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
    usage: { budget: Object.fromEntries((["daily", "weekly", "monthly"] as const).map(window => [window, policy.budget[`${window}_usd`] === null
      ? { limit_usd: null, spent_usd: "0.000000", remaining_usd: null, resets_at: null }
      : { limit_usd: policy.budget[`${window}_usd`], spent_usd: "0", remaining_usd: policy.budget[`${window}_usd`], resets_at: null }])),
    timelock: { delay_ms: 0, scheduled_count: 0 } } });
  const grantView = () => grant && { grant_id: "double-grant", agent_id: agentId, wallet_id: "double-wallet", label: grant.label,
    issued_at: new Date(0).toISOString(), expires_at: grant.expiresAt ?? grantExpiry, revoked_at: grant.revoked ? new Date(0).toISOString() : null,
    revoked_reason: grant.revoked ? "owner" : null, owner_epoch: 1, owner_message: {} };
  const live = () => { const g = grantView(); return g && !g.revoked_at && Date.parse(g.expires_at) > Date.now() ? g : undefined; };
  const isHeld = (op: Op) => op.status === "PENDING_APPROVAL";
  const blocks = (op: Op) => op.refused === null && !(op.status && isTerminal(op.status)) && !isHeld(op);

  /** The journal's answer (src/payout-requests.ts `answer`). */
  const answer = (requestId: string) => {
    const op = journal.get(requestId);
    const known = { requestId, status: op?.status ?? null, correlationId: op?.correlationId ?? null, code: op?.refused ?? null,
      failureCode: null as string | null, neverExecuted: false };
    if (!op) return { ...known, state: "not_found" as const };
    if (op.refused !== null) return { ...known, state: "refused" as const };
    if (op.status === "SUCCESS") return { ...known, state: "succeeded" as const };
    if (op.status && isTerminal(op.status)) return { ...known, ...payoutFailure(op.status, outcome(op)), state: "failed" as const };
    if (isHeld(op)) return { ...known, state: "held" as const };
    if (op.correlationId && op.status && !isUnknownOutcome(op.status)) return { ...known, state: "processing" as const };
    return { ...known, state: "unknown" as const };
  };
  /** The provider's status of a request's payment, as the agent reads it when answering a `failed` request. */
  const outcome = (op: Op) => {
    const payment = op.correlationId ? payments.get(op.correlationId) : undefined;
    return payment && { status: payment.status, ...(payment.rejected && { failure_code: "rejected", details: { never_executed: true } }) };
  };
  /** The journal learns the provider's status, as a status read records it. */
  const refresh = (op: Op) => {
    const payment = op.correlationId ? payments.get(op.correlationId) : undefined;
    if (payment && !(op.status && isTerminal(op.status))) op.status = payment.status;
  };

  /** The provider's destination rule: `any`, `only` the exact entries, or all `except` them (memo-less entries only here). */
  const destinationAllowed = ({ method, request: { recipient } }: Action & { method: "transfer" | "withdraw" }) => {
    const { mode, list } = policy.destinations;
    const listed = list.some(d => d.action === method && d.address === recipient && (method === "transfer" ? d.confidential === true : d.chain === "near" && d.memo === null));
    return mode === "any" || (mode === "only" ? listed : !listed);
  };
  const end = (payment: Payment, outcome: DoubleOutcome) => {
    payment.status = outcome;
    if (outcome === "SUCCESS") balances.set(payment.asset, (BigInt(balances.get(payment.asset) ?? "0") - BigInt(payment.amount)).toString());
  };

  function request(input: { requestId: string; asset: string; delivery: "intents" | { chain: string }; recipient: string; amount: string;
    expectedPolicy: { revision: number; digest: string }; allowDuplicateHeld?: true }) {
    if (input.delivery !== "intents" && input.delivery.chain !== "near")
      throw refused("chain_not_supported", "Payouts withdraw only to chain near. Nothing was sent.");
    const { recipient, asset, amount } = input;
    const action = (input.delivery === "intents"
      ? { method: "transfer", request: { recipient, asset, amount, confidential: true } }
      : { method: "withdraw", request: { asset, amount, chain: "near", recipient, confidential: true } }) as Action & { method: "transfer" | "withdraw" };
    const recorded = journal.get(input.requestId);
    if (recorded) {
      if (recorded.method !== action.method || JSON.stringify(recorded.request) !== JSON.stringify(action.request))
        throw new ORPCError("CONFLICT", { message: "This requestId was already used for other terms. Nothing was sent.", data: { kind: "refused", code: "request_conflict" } });
      return answer(input.requestId);
    }
    if ([...journal.values()].some(blocks))
      throw new ORPCError("CONFLICT", { message: "Earlier money actions have no proven outcome, so nothing new was sent.", data: { kind: "unresolved" } });
    if (chainDown) throw refused("recipient_unchecked", "Whether the recipient can receive this on NEAR couldn't be checked. Nothing was sent; try again.");
    if (!implicit(recipient) && absent.has(recipient)) throw refused("recipient_not_found", `${recipient} is not an account on NEAR. Nothing was sent.`);
    if (action.method === "withdraw" && asset !== ASSETS.wNEAR && WITHDRAWN.has(asset) && unregistered.has(`${asset}\n${recipient}`))
      throw refused("recipient_not_registered", `${recipient} isn't registered on this token's contract. Nothing was sent.`);
    const op: Op = { requestId: input.requestId, method: action.method, request: action.request as Op["request"], at: new Date().toISOString(),
      status: null, refused: null, correlationId: null };
    journal.set(input.requestId, op);
    const refuse = (code: string) => { op.refused = code; return answer(input.requestId); };
    if (input.expectedPolicy.revision !== revision || input.expectedPolicy.digest !== mandateDigest(policy as Policy)) return refuse("reviewed_policy_changed");
    const grantHeld = live();
    if (grantHeld?.label !== "payout" && grantHeld?.label !== "invoices") return refuse("grant_purpose_denied");
    const held = [...journal.values()].filter(isHeld);
    const reserved = held.filter(h => h.request.asset === asset).reduce((sum, h) => sum + BigInt(String(h.request.amount)), 0n);
    const refusal = authorize(action, { purpose: "payout", facts: { now: Date.now(), agentId, view: view() as unknown as Provider["view"], grant: grantHeld as unknown as Provider["grant"],
      available: (BigInt(balances.get(asset) ?? "0") - reserved).toString(), allowDuplicateHeld: input.allowDuplicateHeld === true,
      heldPayouts: held.map(({ request: r }) => ({ recipient: String(r.recipient), asset: String(r.asset), amount: String(r.amount) })) } });
    if (refusal) return refuse(refusal.code);
    // The provider: its own destination and action rules, refused under codes the platform can't prove sent nothing.
    if (!policy.actions.includes(action.method) || !destinationAllowed(action)) return answer(input.requestId);
    const payment: Payment = { correlationId: crypto.randomUUID(), approvalId: crypto.randomUUID(), status: policy.owner_approval ? "PENDING_APPROVAL" : "PROCESSING", asset, amount };
    payments.set(payment.correlationId, payment);
    // Without the owner's approval it settles at once, as `dispatch` waits for a stable status.
    if (!policy.owner_approval) end(payment, "SUCCESS");
    if (loseNext) { loseNext = false; return answer(input.requestId); }
    op.correlationId = payment.correlationId; op.status = payment.status;
    return answer(input.requestId);
  }

  const router = {
    payouts: {
      request: os.input(payoutRequestInput).handler(({ input }) => request(input)),
      status: os.input(payoutStatusInput).handler(({ input }) => {
        const op = journal.get(input.requestId);
        if (op) refresh(op);
        return answer(input.requestId);
      }),
    },
    held: os.handler(() => [...journal.values()].flatMap(op => {
      if (!isHeld(op)) return [];
      refresh(op);
      const payment = payments.get(op.correlationId!)!;
      return isHeld(op) ? [{ at: op.at, kind: "payout", request: op.request, correlationId: payment.correlationId, approvalId: payment.approvalId }] : [];
    })),
    overview: os.handler(() => {
      const unenforced = notInForce(view() as unknown as Provider["view"]);
      return { agentId, book: [], unmanaged: [], target: {}, rebalance: { minLegUsd: 0, maxCostBps: 0 }, policy: view(),
        digest: mandateDigest(policy as Policy), notInForce: unenforced, agreed: [...agreedPayees(policy as Policy)], grants: grant ? [grantView()] : [] };
    }),
  };
  const handler = new RPCHandler(router);
  const prefix = `/apps/v1/o/${encodeURIComponent(organization)}/a/${encodeURIComponent(agent)}/rpc` as const;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: PayoutDouble["fetch"] = async (input, init) => {
    const call = new Request(input, init), url = new URL(call.url);
    if (url.origin !== base) throw new TypeError(`payoutDouble answers only ${base}`);
    if (call.headers.get("authorization") !== `Bearer ${credential}`) return json(401, { error: "The app credential is invalid, expired or revoked" });
    if (!url.pathname.startsWith(`${prefix}/`) || !consented)
      return json(403, { code: "no_consent", access: "agent", error: "No live owner consent covers this Organization and agent" });
    const procedure = url.pathname.slice(prefix.length + 1);
    const covered = (scopes.has("read") && (APP_READS as readonly string[]).includes(procedure))
      || (scopes.has("payout") && (APP_PAYOUT as readonly string[]).includes(procedure));
    if (!covered && [...APP_READS, ...APP_PAYOUT].some(p => p === procedure))
      return json(403, { code: "scope", access: "procedure", error: "No live consent's scopes cover this procedure" });
    const answered = await handler.handle(call, { prefix });
    if (answered.matched) return answered.response;
    unmodelled.push(procedure);
    return json(501, { error: `payoutDouble doesn't model ${procedure}` });
  };

  const find = (requestId: string) => {
    const op = journal.get(requestId), payment = op?.correlationId ? payments.get(op.correlationId) : undefined;
    if (!payment) throw new Error(`No payment was accepted for ${requestId}`);
    return payment;
  };
  return {
    base, credential, fetch, organization, agent,
    reviewedPolicy: () => ({ revision, digest: mandateDigest(policy as Policy) }),
    setPolicy(next, nextState) { policy = structuredClone(next); revision++; state = { ...state, ...nextState }; },
    setPolicyState(nextState) { state = { ...state, ...nextState }; },
    setGrant(next) { grant = next; grantExpiry = new Date(Date.now() + 86_400_000).toISOString(); },
    setBalance(asset, raw) { balances.set(asset, raw); },
    vote(requestId, verdict) {
      const payment = find(requestId);
      if (payment.status !== "PENDING_APPROVAL") throw new Error(`${requestId} isn't held for the owner`);
      // Per the provider's docs, a rejection ends the payment FAILED with `details.never_executed`; `rejected` is the
      // failure code a rejection read on mainnet (2026-10-30).
      payment.status = verdict === "approve" ? "PROCESSING" : "FAILED";
      payment.rejected = verdict === "reject";
    },
    settle(requestId, outcome: DoubleOutcome = "SUCCESS") {
      const payment = find(requestId);
      if (payment.status !== "PROCESSING") throw new Error(`${requestId} isn't moving: vote on it first`);
      end(payment, outcome);
    },
    loseNextAnswer() { loseNext = true; },
    recipients: {
      absent: account => { absent.add(account); },
      unregistered: (account, asset) => { unregistered.add(`${asset}\n${account}`); },
      unchecked: value => { chainDown = value; },
    },
    revokeConsent() { consented = false; },
    requests: (): DoubleRequest[] => [...journal.values()].map(op => ({ requestId: op.requestId, method: op.method, request: { ...op.request },
      status: op.status, refused: op.refused, correlationId: op.correlationId,
      providerStatus: op.correlationId ? payments.get(op.correlationId)!.status : null })),
    unmodelled: () => [...unmodelled],
  };
};
