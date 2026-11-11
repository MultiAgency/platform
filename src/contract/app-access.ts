import { z } from "zod";
import { AppScope } from "./app-consent.js";
import type { OwnerAction } from "./owner-inputs.js";

/**
 * What an app deployment may do through `/apps/v1`: the gateway enforces with these same definitions, and
 * the app client is typed by them. Presenting never authorizes.
 */

/**
 * Reads the app may make with `read` consent. Workflow records (agreements, invoices, work orders) stay out.
 * `payouts/status` answers only the app's own requests (the agent keys each by `app:<deployment>:<organization>` and
 * its `requestId`), so an app whose `payout` consent ended can still follow what it asked for.
 */
export const APP_READS = ["instance", "account", "reconcileBooks", "overview", "policyHistory", "activity", "unresolved", "held", "ledger", "ledgerCsv",
  "owner/actions", "owner/pending", "owner/status", "paymentHistory", "paymentStatus", "payouts/status"] as const;
/** Owner actions with `owner` consent: prepared here, completed only by the owner's own wallet signature at submit. */
export const APP_OWNER = ["owner/prepare", "owner/submit", "owner/status", "owner/pending", "owner/actions"] as const;
/**
 * Payout requests with `payout` consent: each sent at most once under the app's `requestId`, within the owner-signed
 * policy, and held for the owner's vote when the policy says so. `held` shows what waits for that vote. `deposit` gives a
 * one-time address that credits USDC, or wNEAR, to the agent's confidential balance, so the app can fund it; it moves
 * nothing out.
 */
export const APP_PAYOUT = ["payouts/request", "payouts/status", "held", "deposit"] as const;
/**
 * Market hires with `market` consent (docs/market.md): a quote moves nothing; a hire pays one listed agent over x402 at
 * most once under the app's `requestId`, only while a fresh quote equals the terms the app asks for, from the agent's
 * payment key, within the owner-signed policy; `market/status` follows it; `market/account` shows the payment key and
 * the owner's one-time registration; `deposit` funds the agent. For a DAO, each hire is paid only after its vote.
 */
export const APP_MARKET = ["market/quote", "market/hire", "market/status", "market/account", "deposit"] as const;
/**
 * Treasury with `treasury` consent (docs/enforcement.md, "Treasury proposals"): reads; strategy settings, which an
 * app's plans, a machine credential's plans and the autopilot use only under a grant binding their digest; autopilot on
 * (under such a grant) and off; sweeping public balances into the confidential one; `deposit`, a one-time address that
 * credits only the agent's own confidential balance, so the app can fund it; `autopilot/tick`, one autopilot pass now,
 * swapping only under a grant that binds the saved strategy and within its per-run ceiling; for a wallet owner, the
 * linked treasury account (`treasury/link`, `unlink`); and proposals, whose swaps execute only after
 * the owner signs their exact terms.
 */
export const APP_TREASURY = ["strategy/get", "autopilot/get", "autopilot/evidence", "autopilot/log", "treasury/get", "strategy/save",
  "autopilot/enable", "autopilot/stop", "autopilot/tick", "sweep", "deposit", "treasury/link", "treasury/unlink",
  "proposals/create", "proposals/get", "proposals/list", "proposals/approve",
  "proposals/reject", "proposals/withdraw", "proposals/execute"] as const;
/**
 * With `treasury-execute` as well: plans prepared and executed within the owner's policy and the strategy's cost limit,
 * without a signature per swap, and only under a grant binding the plan's strategy (src/planning/strategy-grant.ts).
 */
export const APP_TREASURY_EXECUTE = ["rebalance", "externalPlan", "executePlan"] as const;
export type AppProcedure = (typeof APP_READS)[number] | (typeof APP_OWNER)[number] | (typeof APP_PAYOUT)[number]
  | (typeof APP_TREASURY)[number] | (typeof APP_TREASURY_EXECUTE)[number] | (typeof APP_MARKET)[number];
const READS = new Set<string>(APP_READS), OWNER = new Set<string>(APP_OWNER), PAYOUT = new Set<string>(APP_PAYOUT),
  TREASURY = new Set<string>(APP_TREASURY), TREASURY_EXECUTE = new Set<string>(APP_TREASURY_EXECUTE), MARKET = new Set<string>(APP_MARKET);
/** Whether consent scopes cover a procedure (the gateway also requires the owner's own access to it). */
export const appScopesCover = (scopes: readonly AppScope[], path: string) =>
  (scopes.includes("read") && READS.has(path)) || (scopes.includes("owner") && OWNER.has(path)) || (scopes.includes("payout") && PAYOUT.has(path))
  || (scopes.includes("treasury") && TREASURY.has(path))
  || (scopes.includes("treasury") && scopes.includes("treasury-execute") && TREASURY_EXECUTE.has(path))
  || (scopes.includes("market") && MARKET.has(path));

/**
 * What the app may ask an owner to sign. The app chooses what it asks for, but never what the owner reads: a prepared
 * intent reaches the app only when it is NEP-413, whose text the owner's wallet shows. A NEP-366 intent (creation,
 * freeze, unfreeze, on-chain policy edits) is held on the platform, and the app gets a confirm page instead, where the
 * platform shows the owner its own record of the action and the owner signs; the app gets those bytes only with the
 * owner's signature over the link's text, which tells the owner in the wallet to sign it only on the platform. Payees are added after creation, not at it. A
 * vote on a held payout is bound by the agent to that payout's provider evidence and re-authorized under the current
 * policy, so it can release only a transfer to an agreed payee within the caps; its prepared answer carries the proven
 * terms for the app to show.
 */
const APP_OWNER_ACTIONS = new Set(["agent_create", "agent_freeze", "agent_unfreeze", "agent_archive", "agent_restore", "grant_issue", "grant_revoke", "policy_update", "approval_vote"]);
/** Whether a parsed owner action is one the app may prepare (signer `wallet` is checked separately). */
export function appMayAsk(action: { type: string; payees?: readonly unknown[] }) {
  if (action.type === "agent_create" && action.payees?.length) return false;
  return APP_OWNER_ACTIONS.has(action.type);
}
type Of<T extends OwnerAction["type"]> = Extract<OwnerAction, { type: T }>;
/** The owner actions an app may prepare, as types. The gateway's check (`appMayAsk`) is the authority. */
export type AppOwnerAction =
  | (Omit<Of<"agent_create">, "payees"> & { owner: NonNullable<Of<"agent_create">["owner"]> })
  | Of<"agent_freeze"> | Of<"agent_unfreeze"> | Of<"agent_archive"> | Of<"agent_restore"> | Of<"grant_issue"> | Of<"grant_revoke"> | Of<"approval_vote"> | Of<"policy_update">;

/**
 * A NEP-366 owner action the platform holds for the owner to sign on its confirm page (`/confirm/<token>`). The link
 * shows the action's terms to whoever holds it; the bytes to sign go only to whoever presents the owner's signature over
 * the link's text, which the page asks the owner's wallet for. Open it for the owner right away: the intent expires in minutes. Follow the outcome with
 * `owner/status`; the app can't submit it. A vote on a held payout carries one too, showing its proven terms, beside
 * its `intent`, which the app may still submit (#48).
 */
export const appConfirm = z.looseObject({ url: z.string(), expiresAt: z.string() });

/**
 * Who signs as an agent's owner: the owner's own wallet, or a Sputnik DAO by a passed proposal (its MPC key on the
 * `agent-owner` path). Absent on records and answers from before DAO consent: those are `wallet`.
 */
export const AppSigner = z.enum(["wallet", "dao"]);
/**
 * The scopes a DAO's consent may carry: reads, Treasury settings, autopilot and proposals the DAO approves by vote, and
 * with `treasury-execute` the app's plans within the policy and the strategy the DAO's grant binds, without a vote
 * each time. Not `owner` (the platform files a DAO's owner actions itself) or `payout` (not yet).
 */
export const DAO_CONSENT_SCOPES = ["read", "treasury", "treasury-execute", "market"] as const satisfies readonly AppScope[];
/**
 * What a DAO's `treasury` consent doesn't cover although a wallet owner's does: the linked treasury account. A DAO-owned
 * agent's link is the DAO itself, fixed at setup (src/hosted-binding.ts): an app never changes which DAO it answers to.
 */
export const DAO_APP_REFUSED = ["treasury/link", "treasury/unlink"] as const;
/** Whether a DAO's consent scopes cover a procedure: as `appScopesCover`, less `DAO_APP_REFUSED`. */
export const daoScopesCover = (scopes: readonly AppScope[], path: string) =>
  appScopesCover(scopes, path) && !(DAO_APP_REFUSED as readonly string[]).includes(path);

/** `GET /apps/v1/agents/<agent>`: what the owner's consent must name. */
export const appAgent = z.looseObject({ agent: z.string(), owner: z.string(), agentId: z.string().nullable(), created: z.boolean(),
  host: z.string(), deployment: z.string(), signer: AppSigner.optional() });
/** A stored consent as the platform shows it: never its message, nonce or signature. Times are epoch milliseconds. */
export const appConsentView = z.looseObject({ id: z.string(), deployment: z.string(), host: z.string(), organization: z.string(),
  owner: z.string(), agent: z.string(), agentId: z.string(), scopes: z.array(AppScope), expiresAt: z.number(), createdAt: z.number(),
  publicKey: z.string(), revoked: z.boolean(), revokedAt: z.number().nullable(), signer: AppSigner.optional() });

/**
 * The owner actions an app may ask a DAO to vote on, under its `treasury` consent: the platform prepares each with
 * `signer: "dao"` and answers the proposal a member files; the agent submits the DAO's signature once the vote passes.
 * Each is a provider owner intent that expires in minutes, so the vote must pass within `expiresAt`.
 */
export const DAO_APP_ACTIONS = ["grant_issue", "grant_revoke", "policy_update", "agent_freeze", "agent_unfreeze"] as const;
/**
 * Whether a parsed owner action is one an app may ask a DAO to vote on: a Treasury grant, the revocation of a grant
 * (which only removes authority), a policy edit that changes something, freeze or unfreeze, or, under
 * a DAO's setup consent only, the Treasury agent's creation (its owner is the DAO's derived account, never given).
 */
export function appMayAskDao(action: { type: string; label?: string; owner?: unknown; role?: string; payees?: readonly unknown[]; changes?: object }) {
  if (action.type === "agent_create") return action.owner === undefined && !action.payees?.length && ["treasury", "market"].includes(action.role ?? "treasury");
  if (action.type === "policy_update") {
    // On-chain edits too: like a wallet owner, members rely on the provider's preview of the encrypted policy.
    return Object.keys(action.changes ?? {}).length > 0;
  }
  return (DAO_APP_ACTIONS as readonly string[]).includes(action.type) && (action.type !== "grant_issue" || action.label === "treasury" || action.label === "market");
}
export type AppDaoAction = Of<"agent_freeze"> | Of<"agent_unfreeze"> | (Of<"grant_issue"> & { label: "treasury" | "market" }) | Of<"grant_revoke"> | Of<"policy_update">
  | { type: "agent_create"; role?: "treasury" | "market" };
/**
 * The policy fields a DAO's `market` consent may ask the DAO to change on its market agent: its caps only (user,
 * 2026-11-11). A cap can't move money by itself: every hire is paid only after the DAO's vote on its exact terms, and a
 * top-up only to the payment key, by what an approved hire lacks. Destinations, assets, actions and owner approval
 * would change what the agent is, and stay under `treasury`.
 */
export const DAO_MARKET_POLICY_FIELDS = ["limits", "budget", "max_actions_per_hour"] as const;
/**
 * Whether a DAO's `market` consent covers preparing this owner action on its market agent (#67): the `market` grant and
 * its revocation, freeze and unfreeze, and a policy edit of `DAO_MARKET_POLICY_FIELDS` only. Each is still a proposal
 * the DAO votes on.
 */
export function daoMarketMayAsk(action: { type: string; label?: string; changes?: object }) {
  if (action.type === "grant_issue") return action.label === "market";
  if (action.type === "grant_revoke" || action.type === "agent_freeze" || action.type === "agent_unfreeze") return true;
  if (action.type !== "policy_update") return false;
  // A field sent as undefined leaves the policy's field as it is (owner-requests.ts), so it isn't a change.
  const fields = Object.entries(action.changes ?? {}).filter(([, value]) => value !== undefined).map(([field]) => field);
  return fields.length > 0 && fields.every(field => (DAO_MARKET_POLICY_FIELDS as readonly string[]).includes(field));
}
/** The areas a DAO may set up a hosted agent for through an app: Treasury, and a market agent whose hires it votes on (user, 2026-11-09). */
export const DAO_SETUP_AREAS = ["treasury", "market"] as const;

/** A NEAR transaction for a DAO member's wallet to sign, as near-kit builds it (receiver and function-call actions). */
const memberTransaction = z.looseObject({ receiverId: z.string(), actions: z.array(z.looseObject({ type: z.literal("FunctionCall"), params: z.looseObject({}) })) });
/**
 * A DAO's consent waiting for its vote. `hash` is the NEP-413 hash the DAO's key signs; `description` is what the
 * proposal says. A member files `proposal`, or files and votes with `proposalAndVote` (null when the DAO's next proposal
 * id couldn't be read). It must pass before `votingUntil` (epoch milliseconds).
 */
export const appDaoConsentRequest = z.looseObject({ id: z.string(), dao: z.string(), organization: z.string(), agent: z.string(),
  agentId: z.string(), scopes: z.array(AppScope), expiresAt: z.number(), votingUntil: z.number(), hash: z.string(), description: z.string() });
export const appDaoConsentFiled = z.looseObject({ request: appDaoConsentRequest,
  transactions: z.looseObject({ proposal: memberTransaction.nullable(), proposalAndVote: memberTransaction.nullable() }) });
/**
 * A DAO's vote on a Treasury proposal, filed by the platform from the proposal's own text (`proposalText`): it must pass
 * before `votingUntil`. Once the DAO's signature is found the platform relays it to `proposals/approve` or `reject`.
 */
export const appDaoVoteRequest = z.looseObject({ id: z.string(), dao: z.string(), organization: z.string(), agent: z.string(),
  agentId: z.string(), proposal: z.string(), verdict: z.enum(["approve", "reject"]), votingUntil: z.number(), hash: z.string(), description: z.string() });
export const appDaoVoteFiled = z.looseObject({ request: appDaoVoteRequest,
  transactions: z.looseObject({ proposal: memberTransaction.nullable(), proposalAndVote: memberTransaction.nullable() }) });
/** A proposal vote's state: waiting for the vote, or relayed to the agent, with the proposal's state then. */
export const appDaoVoteState = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("pending"), request: appDaoVoteRequest }),
  z.looseObject({ state: z.literal("relayed"), request: appDaoVoteRequest, proposalState: z.string() }),
]);
/**
 * A DAO's approval of one market hire (docs/market.md), filed by the platform from its own text (`hireText`): it must
 * pass before `votingUntil`. Once the DAO's signature is found the platform relays it to `market/approve`, which pays the
 * hire once; `hireState` is that hire's state as the agent answered (`market/status` follows it from there).
 */
export const appDaoHireRequest = z.looseObject({ id: z.string(), dao: z.string(), organization: z.string(), agent: z.string(),
  agentId: z.string(), requestId: z.string(), approved: z.looseObject({}), validUntil: z.string(), votingUntil: z.number(), hash: z.string(), description: z.string() });
export const appDaoHireFiled = z.looseObject({ request: appDaoHireRequest,
  transactions: z.looseObject({ proposal: memberTransaction.nullable(), proposalAndVote: memberTransaction.nullable() }) });
export const appDaoHireState = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("pending"), request: appDaoHireRequest }),
  z.looseObject({ state: z.literal("relayed"), request: appDaoHireRequest, hireState: z.string() }),
]);
/**
 * A DAO's request that the platform set up a hosted agent for it, signed by its vote (the setup text, `setupMessage`,
 * with the DAO as owner). Once the signature is found the platform reserves the agent and stores a setup consent; the
 * app then asks for `agent_create` with `signer: "dao"`, a second vote that must pass within the intent's minutes.
 */
export const appDaoSetupRequest = z.looseObject({ id: z.string(), dao: z.string(), organization: z.string(), area: z.string(),
  expiresAt: z.number(), votingUntil: z.number(), hash: z.string(), description: z.string() });
export const appDaoSetupFiled = z.looseObject({ request: appDaoSetupRequest,
  transactions: z.looseObject({ proposal: memberTransaction.nullable(), proposalAndVote: memberTransaction.nullable() }) });
export const appDaoSetupState = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("pending"), request: appDaoSetupRequest }),
  z.looseObject({ state: z.literal("reserved"), agent: z.string(), consent: appConsentView }),
]);
/** A DAO consent's state: still waiting for the vote, or stored once the DAO's signature was found on chain. */
export const appDaoConsentState = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("pending"), request: appDaoConsentRequest }),
  z.looseObject({ state: z.literal("signed"), consent: appConsentView }),
]);
export const appConsentList = z.looseObject({ consents: z.array(appConsentView) });
export const appConsentStored = z.looseObject({ consent: appConsentView });
/** `POST /apps/v1/setup`: the hosted agent's name and its setup consent (agent ID `unborn`). */
export const appSetupStored = z.looseObject({ agent: z.string(), consent: appConsentView });
/**
 * `GET /apps/v1/agents?organization=`: the hosted agents this deployment's setups reserved for that Organization (one per
 * owner and area), narrowed by `owner` and `area`. How an app whose setup reply was lost learns the agent's name.
 */
export const appReservations = z.looseObject({ agents: z.array(z.looseObject({ agent: z.string(), organization: z.string(), owner: z.string(), area: z.string(), released: z.boolean().optional() })) });
export const appRevoked = z.looseObject({ revoked: z.literal(true) });
/** A NEP-413 nonce (32 bytes, base64) the platform issued this deployment, and when (ms). */
export const appConsentNonce = z.looseObject({ nonce: z.string(), issuedAt: z.number() });

/**
 * Why the gateway refused an app's request: the `code` on a `refused` or `forbidden` result from the app routes, and on
 * a gateway `forbidden` from an agent call through them. Older gateways name none. Grouped by what the app does next:
 * - Fix the request: `invalid_request`, `not_found`, `signature_invalid`, `browser` (call from the server).
 * - Use another route: `dao_owned` (file it for the DAO's vote), `not_dao` (the wallet signs it), `confirm_page` (the
 *   owner signs on the platform's page), `not_created` (set the agent up first), `already_created` (ask for a consent).
 * - Ask the owner (or DAO) to sign again, after reading the agent's identity: `agent_changed`, `owner_changed`,
 *   `consent_ended`, `consent_revoked`, `no_consent`, `scope` (a consent with that scope), `setup_key` (create with the
 *   key that signed the setup), `signed_expired`, `vote_lapsed`, `dao_stopped`, `owner_stopped` (the owner's wallet stop
 *   covers this agent: ask for a consent nonce, and ask the owner to sign the text with it).
 * - Not for this app or host: `not_owner`, `not_allowed`, `setup_unavailable`, `access_ended` (its credential or consent
 *   ended while the request was checked; nothing was stored, filed or forwarded).
 * - Wait, then file again: `dao_requests_limited` (the deployment's DAO requests waiting for a vote, or filed in the last
 *   day, are at their limit).
 * - Proposals: `proposal_unanswered`, `proposal_not_open` (filing a vote, or relaying one, once the proposal is no longer
 *   open: the DAO's vote can't apply to it), `expires_too_soon`.
 * - `too_many_consents`: the deployment holds its limit of live consents; revoke unused ones first.
 * - `setup_failed`: the agent couldn't be set up (the message says why).
 * - `agent_refused`: the agent refused the DAO's signed verdict while its proposal is open; reading the vote again
 *   relays the same signature, so it may succeed once the agent's state allows it.
 */
export const APP_GATEWAY_CODES = ["invalid_request", "not_found", "signature_invalid", "browser", "dao_owned", "not_dao", "confirm_page",
  "not_created", "already_created", "agent_changed", "owner_changed", "consent_ended", "consent_revoked", "no_consent", "scope", "setup_key",
  "signed_expired", "vote_lapsed", "dao_stopped", "owner_stopped", "not_owner", "not_allowed", "setup_unavailable", "access_ended", "proposal_unanswered",
  "proposal_not_open", "expires_too_soon", "setup_failed", "agent_refused", "too_many_consents", "dao_requests_limited", "brief_mismatch", "agent_released"] as const;
export type AppGatewayCode = (typeof APP_GATEWAY_CODES)[number];
