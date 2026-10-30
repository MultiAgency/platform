import { z } from "zod";
import { AppScope } from "./app-consent.js";
import type { OwnerAction } from "./owner-inputs.js";

/**
 * What an app deployment may do through `/apps/v1`: the gateway enforces with these same definitions, and
 * the app client is typed by them. Presenting never authorizes.
 */

/** Reads the app may make with `read` consent. Workflow records (agreements, invoices, work orders) stay out. */
export const APP_READS = ["instance", "overview", "policyHistory", "activity", "unresolved", "held", "ledger", "ledgerCsv",
  "owner/actions", "owner/pending", "owner/status", "paymentHistory", "paymentStatus"] as const;
/** Owner actions with `owner` consent: prepared here, completed only by the owner's own wallet signature at submit. */
export const APP_OWNER = ["owner/prepare", "owner/submit", "owner/status", "owner/pending", "owner/actions"] as const;
/**
 * Payout requests with `payout` consent: each sent at most once under the app's `requestId`, within the owner-signed
 * policy, and held for the owner's vote when the policy says so. `held` shows what waits for that vote. `deposit` gives a
 * one-time address that credits USDC, or wNEAR, to the agent's confidential balance, so the app can fund it; it moves
 * nothing out.
 */
export const APP_PAYOUT = ["payouts/request", "payouts/status", "held", "deposit"] as const;
export type AppProcedure = (typeof APP_READS)[number] | (typeof APP_OWNER)[number] | (typeof APP_PAYOUT)[number];
const READS = new Set<string>(APP_READS), OWNER = new Set<string>(APP_OWNER), PAYOUT = new Set<string>(APP_PAYOUT);
/** Whether consent scopes cover a procedure (the gateway also requires the owner's own access to it). */
export const appScopesCover = (scopes: readonly AppScope[], path: string) =>
  (scopes.includes("read") && READS.has(path)) || (scopes.includes("owner") && OWNER.has(path)) || (scopes.includes("payout") && PAYOUT.has(path));

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
const APP_OWNER_ACTIONS = new Set(["agent_create", "agent_freeze", "agent_unfreeze", "grant_issue", "grant_revoke", "policy_update", "approval_vote"]);
/** Whether a parsed owner action is one the app may prepare (signer `wallet` is checked separately). */
export function appMayAsk(action: { type: string; payees?: readonly unknown[] }) {
  if (action.type === "agent_create" && action.payees?.length) return false;
  return APP_OWNER_ACTIONS.has(action.type);
}
type Of<T extends OwnerAction["type"]> = Extract<OwnerAction, { type: T }>;
/** The owner actions an app may prepare, as types. The gateway's check (`appMayAsk`) is the authority. */
export type AppOwnerAction =
  | (Omit<Of<"agent_create">, "payees"> & { owner: NonNullable<Of<"agent_create">["owner"]> })
  | Of<"agent_freeze"> | Of<"agent_unfreeze"> | Of<"grant_issue"> | Of<"grant_revoke"> | Of<"approval_vote"> | Of<"policy_update">;

/**
 * A NEP-366 owner action the platform holds for the owner to sign on its confirm page (`/confirm/<token>`). The link
 * shows the action's terms to whoever holds it; the bytes to sign go only to whoever presents the owner's signature over
 * the link's text, which the page asks the owner's wallet for. Open it for the owner right away: the intent expires in minutes. Follow the outcome with
 * `owner/status`; the app can't submit it.
 */
export const appConfirm = z.looseObject({ url: z.string(), expiresAt: z.string() });

/** `GET /apps/v1/agents/<agent>`: what the owner's consent must name. */
export const appAgent = z.looseObject({ agent: z.string(), owner: z.string(), agentId: z.string().nullable(), created: z.boolean(),
  host: z.string(), deployment: z.string() });
/** A stored consent as the platform shows it: never its message, nonce or signature. Times are epoch milliseconds. */
export const appConsentView = z.looseObject({ id: z.string(), deployment: z.string(), host: z.string(), organization: z.string(),
  owner: z.string(), agent: z.string(), agentId: z.string(), scopes: z.array(AppScope), expiresAt: z.number(), createdAt: z.number(),
  publicKey: z.string(), revoked: z.boolean(), revokedAt: z.number().nullable() });
export const appConsentList = z.looseObject({ consents: z.array(appConsentView) });
export const appConsentStored = z.looseObject({ consent: appConsentView });
/** `POST /apps/v1/setup`: the hosted agent's name and its setup consent (agent ID `unborn`). */
export const appSetupStored = z.looseObject({ agent: z.string(), consent: appConsentView });
export const appRevoked = z.looseObject({ revoked: z.literal(true) });
