import { createGrantCredential, grantCommitment } from "@near-intents-agent-api/sdk";

import { api } from "./api.js";
import { DEFAULT_GRANT_MS, GRANT_LABELS, type GrantLabel, MAX_GRANT_MS, MIN_GRANT_MS } from "./contract/inputs.js";
export { GRANT_LABELS, type GrantLabel };
import { agentId, saveEnv } from "./env.js";
import { PublicError } from "./public-error.js";
import { loadStrategy } from "./strategy.js";
import { strategyDigest, strategyLabelSuffix } from "./strategy-digest.js";
import { currentWorkOrder, workOrderInvoice } from "./work-order-store.js";


/**
 * A grant's label, which the owner sees when signing and the API shows on every operation the grant
 * sends: its purpose, then optionally a suffix the owner's signature binds too, such as a strategy
 * digest. The API takes at most 64 characters.
 */
export function grantLabel(label: GrantLabel, suffix?: string) {
  const full = suffix ? `${label}:${suffix}` : label;
  if (full.length > 64) throw new Error(`Grant label "${full}" is longer than the API's 64 characters`);
  return full;
}


/**
 * The label of this agent's grants when none is named: `GRANT_PURPOSE` when this instance is set
 * up to issue one (an instance that only issues the invoice page's grant), otherwise what the
 * policy allows: an agent that swaps manages a treasury.
 */
async function agentGrantLabel(): Promise<GrantLabel> {
  const configured = process.env.GRANT_PURPOSE;
  if (configured) {
    if (!GRANT_LABELS.includes(configured as GrantLabel)) throw new Error(`GRANT_PURPOSE must be one of ${GRANT_LABELS.join(", ")}`);
    return configured as GrantLabel;
  }
  const { policy } = await api.getPolicy(agentId());
  return policy?.actions.includes("swap") ? "treasury" : "payout";
}

/**
 * When a new grant ends: the work order's deadline under one, else the owner's `expiresAt` between `MIN_GRANT_MS` and
 * `MAX_GRANT_MS` ahead (refused outside, never clamped: the owner signs what they asked for), else `DEFAULT_GRANT_MS`.
 */
function grantExpiry(expiresAt: string | undefined, until: string | undefined, now = Date.now()) {
  if (until !== undefined) {
    if (expiresAt !== undefined && Date.parse(expiresAt) !== Date.parse(until)) throw new PublicError("A work order's grant expires at the order's deadline.");
    return until;
  }
  if (expiresAt === undefined) return new Date(now + DEFAULT_GRANT_MS).toISOString();
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) throw new PublicError("Name the grant's expiry as an ISO timestamp.");
  if (at < now + MIN_GRANT_MS || at > now + MAX_GRANT_MS) throw new PublicError("A grant expires between an hour and 365 days from now.");
  return new Date(at).toISOString();
}

/**
 * A fresh grant credential: the token is the agent's secret, the commitment is what the owner signs.
 * A treasury grant's label carries the strategy in force (`strategyLabelSuffix`), so signing it is
 * the owner's approval of that strategy, which the autopilot requires before acting alone.
 */
export async function grantRequest({ label, suffix, expectedStrategyDigest, expiresAt, requireStrategyReview = false }: { label?: GrantLabel; suffix?: string; expectedStrategyDigest?: string; expiresAt?: string; requireStrategyReview?: boolean } = {}) {
  const chosen = label ?? (await agentGrantLabel());
  const order = currentWorkOrder();
  if (order) {
    workOrderInvoice(order, order.payee);
    if (chosen !== "invoices" || suffix !== undefined) throw new Error("A work order requires its invoices grant.");
  }
  const expires = grantExpiry(expiresAt, order?.until);
  const strategy = chosen === "treasury" ? loadStrategy() : null;
  if (strategy && (requireStrategyReview || expectedStrategyDigest !== undefined)) {
    if (requireStrategyReview && process.env.AUTOPILOT === "on") throw new Error("Turn the schedule off before authorizing a Treasury strategy.");
    if (expectedStrategyDigest !== strategyDigest(strategy)) throw new PublicError("Review the current saved strategy before authorizing its grant; the strategy changed or was not reviewed.");
    if (suffix !== undefined && suffix !== strategyLabelSuffix(strategy)) throw new Error("The grant suffix does not match the reviewed strategy.");
  }
  const full = grantLabel(chosen, strategy && (requireStrategyReview || expectedStrategyDigest !== undefined)
    ? strategyLabelSuffix(strategy) : suffix ?? (strategy ? strategyLabelSuffix(strategy) : undefined));
  const { token, commitment } = createGrantCredential();
  return {
    token,
    request: {
      type: "grant_issue",
      agent_id: agentId(),
      label: full,
      credential: commitment,
      expires_at: expires,
    } as const,
  };
}

/**
 * Saves a new grant's token before the owner signs, since a grant whose token is lost is useless,
 * but beside the token in use: that one keeps working until the new grant is in force.
 */
export function stageGrantToken(token: string) {
  saveEnv({ AGENT_GRANT_TOKEN_PENDING: token });
}

/** Makes a staged token the agent's credential, once its grant is in force. */
export function promoteGrantToken(token: string) {
  const staged = process.env.AGENT_GRANT_TOKEN_PENDING === token;
  saveEnv({ AGENT_GRANT_TOKEN: token, ...(staged && { AGENT_GRANT_TOKEN_PENDING: "" }) });
}

type Grant = Awaited<ReturnType<typeof api.listGrants>>[number];

/** Neither revoked nor expired at `now`. */
export const isLive = (grant: Pick<Grant, "revoked_at" | "expires_at">, now = Date.now()) =>
  !grant.revoked_at && Date.parse(grant.expires_at) > now;

/** The live grant whose credential is `token`, if any. */
export const liveGrant = (grants: Grant[], token: string | undefined) =>
  token ? grants.find((g) => isLive(g) && g.owner_message.credential === grantCommitment(token)) : undefined;

/**
 * Promotes the staged token once its grant is in force, also when the run that staged it stopped
 * before promoting it (a crash, a status wait that timed out). The owner signed that grant, so it
 * may replace the token in use even while that one still works.
 */
export function adoptStagedGrant(grants: Grant[]) {
  const staged = process.env.AGENT_GRANT_TOKEN_PENDING;
  if (staged && liveGrant(grants, staged)) promoteGrantToken(staged);
}
