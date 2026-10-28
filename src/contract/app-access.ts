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
 * policy, and held for the owner's vote when the policy says so. `held` shows what waits for that vote.
 */
export const APP_PAYOUT = ["payouts/request", "payouts/status", "held"] as const;
export type AppProcedure = (typeof APP_READS)[number] | (typeof APP_OWNER)[number] | (typeof APP_PAYOUT)[number];
const READS = new Set<string>(APP_READS), OWNER = new Set<string>(APP_OWNER), PAYOUT = new Set<string>(APP_PAYOUT);
/** Whether consent scopes cover a procedure (the gateway also requires the owner's own access to it). */
export const appScopesCover = (scopes: readonly AppScope[], path: string) =>
  (scopes.includes("read") && READS.has(path)) || (scopes.includes("owner") && OWNER.has(path)) || (scopes.includes("payout") && PAYOUT.has(path));

/**
 * What the app may ask an owner to sign. The app chooses the content and its preview, so an action must be
 * readable in the owner's wallet (NEP-413) or built entirely by platform code. A NEP-366 policy edit carries the policy
 * encrypted, so an edit is allowed only on API-enforced fields, and the gateway also releases its prepared intent only
 * when it comes back NEP-413: rebuilding destinations can change provider-enforced `actions` too.
 */
export const PLATFORM_BUILT_ACTIONS = ["agent_create", "agent_freeze", "agent_unfreeze"] as const;
const PLATFORM_BUILT = new Set<string>(PLATFORM_BUILT_ACTIONS);
const READABLE = new Set(["grant_issue", "grant_revoke", "policy_update"]);
const API_ENFORCED = new Set(["destinations", "budget"]);
export const isPlatformBuilt = (type: string) => PLATFORM_BUILT.has(type);
/** Whether a parsed owner action is one the app may prepare (signer `wallet` is checked separately). */
export function appMayAsk(action: { type: string; payees?: readonly unknown[]; changes?: Record<string, unknown> }) {
  if (action.type === "agent_create" && action.payees?.length) return false;
  if (action.type === "policy_update" && !Object.entries(action.changes ?? {}).every(([key, value]) => value === undefined || API_ENFORCED.has(key))) return false;
  return PLATFORM_BUILT.has(action.type) || READABLE.has(action.type);
}
type Of<T extends OwnerAction["type"]> = Extract<OwnerAction, { type: T }>;
/** The owner actions an app may prepare, as types. The gateway's check (`appMayAsk`) is the authority. */
export type AppOwnerAction =
  | (Omit<Of<"agent_create">, "payees"> & { owner: NonNullable<Of<"agent_create">["owner"]> })
  | Of<"agent_freeze"> | Of<"agent_unfreeze"> | Of<"grant_issue"> | Of<"grant_revoke">
  | (Omit<Of<"policy_update">, "changes"> & { changes: Pick<Of<"policy_update">["changes"], "destinations" | "budget"> });

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
