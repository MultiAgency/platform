import { z } from "zod";
import { appConsent, appConsentSubmission } from "./app-consent.js";

/**
 * A payee's own view of the policy that pays them, read from the platform host with no app in between. Two NEP-413
 * signatures, recipient the platform host, authorize it:
 * - the owner's **payee disclosure**: this agent (by name and provider ID) may show this payee their terms, until
 *   `expiresAt` (at most 366 days). The owner signs it once, typically where they agree the payee's terms in an app.
 * - the payee's **read**: this payee asks now (at most an hour).
 * The platform answers `payeePolicyProof`: the payee's own destination entries, the per-transaction caps of the assets the
 * agent may spend, `owner_approval`, `frozen`, whether the policy is in force, and its revision, read
 * from the provider's current policy by the agent, and its mandate digest only when the owner's disclosure opts in. Never
 * other payees, balances, budgets or other limits. It moves nothing.
 * Zod only: the payee entry carries it.
 */
export const PAYEE_DISCLOSURE_TYPE = "multiagency.payee-disclosure";
export const PAYEE_READ_TYPE = "multiagency.payee-policy-read";
/** Where the platform host answers it. */
export const PAYEE_POLICY_PATH = "/confirm/v1/payee-policy";
/** A read is signed to be sent now. */
export const MAX_PAYEE_READ_MS = 3_600_000;

/**
 * The disclosure lists exactly what the payee is shown. `discloseDigest` is the owner's opt-in to the mandate digest
 * (src/mandate.ts) of the provider's current policy as well. The digest commits to the whole policy, budgets and every
 * other payee included, so a payee who can guess the rest of a simple policy can confirm the guess by recomputing it, and
 * learn those limits. Without the opt-in the answer carries the revision only, which shows that the policy changed but
 * confirms no guess. It is the owner's choice, in the text they sign; an app can't add it.
 */
export const payeeDisclosure = z.strictObject({
  type: z.literal(PAYEE_DISCLOSURE_TYPE),
  version: z.literal(1),
  host: appConsent.shape.host,
  owner: appConsent.shape.owner,
  agent: appConsent.shape.agent,
  /** The agent's provider ID when the owner signs: a replacement agent under the same name isn't covered. */
  agentId: appConsent.shape.agentId,
  /** The NEAR account being paid: the address of its own destination entries. */
  payee: appConsent.shape.owner,
  expiresAt: z.iso.datetime(),
  /** The owner's opt-in to the mandate digest in the answer. Absent, not false, when the owner doesn't opt in. */
  discloseDigest: z.literal(true).optional(),
});
export type PayeeDisclosure = z.output<typeof payeeDisclosure>;

export const payeePolicyRead = z.strictObject({
  type: z.literal(PAYEE_READ_TYPE),
  version: z.literal(1),
  host: appConsent.shape.host,
  payee: appConsent.shape.owner,
  agent: appConsent.shape.agent,
  expiresAt: z.iso.datetime(),
});
export type PayeePolicyRead = z.output<typeof payeePolicyRead>;

/**
 * The canonical disclosure text the owner signs: fixed key order, no whitespace. `"discloseDigest":true` comes last and
 * only when the owner opts in, so a disclosure without it is the same text as before the opt-in existed.
 */
export function payeeDisclosureMessage(fields: Omit<PayeeDisclosure, "type" | "version">): string {
  const v = payeeDisclosure.parse({ type: PAYEE_DISCLOSURE_TYPE, version: 1, ...fields });
  return JSON.stringify({ type: v.type, version: v.version, host: v.host, owner: v.owner, agent: v.agent, agentId: v.agentId, payee: v.payee, expiresAt: v.expiresAt,
    ...(v.discloseDigest ? { discloseDigest: true } : {}) });
}

/** The canonical read text the payee signs: fixed key order, no whitespace. */
export function payeePolicyReadMessage(fields: Omit<PayeePolicyRead, "type" | "version">): string {
  const v = payeePolicyRead.parse({ type: PAYEE_READ_TYPE, version: 1, ...fields });
  return JSON.stringify({ type: v.type, version: v.version, host: v.host, payee: v.payee, agent: v.agent, expiresAt: v.expiresAt });
}

const parsedAs = <T extends { type: string; version: number }>(schema: z.ZodType<T>, canonical: (fields: Omit<T, "type" | "version">) => string) =>
  (message: string): T | null => {
    let value: unknown;
    try { value = JSON.parse(message); } catch { return null; }
    const parsed = schema.safeParse(value);
    if (!parsed.success) return null;
    const { type: _type, version: _version, ...fields } = parsed.data;
    return canonical(fields) === message ? parsed.data : null;
  };
/** The disclosure a signed text states, or null unless the text is exactly its canonical form. */
export const parsePayeeDisclosureMessage = parsedAs(payeeDisclosure, payeeDisclosureMessage);
/** The read a signed text states, or null unless the text is exactly its canonical form. */
export const parsePayeePolicyReadMessage = parsedAs(payeePolicyRead, payeePolicyReadMessage);

/** `POST /confirm/v1/payee-policy`: each signed text with its NEP-413 nonce (32 bytes, base64), key and signature. */
export const payeePolicyRequest = z.strictObject({ disclosure: appConsentSubmission, read: appConsentSubmission });
export type PayeePolicyRequest = z.input<typeof payeePolicyRequest>;

/** One of the payee's own destination entries, and whether the policy's actions include its action. */
export const payeeDestination = z.discriminatedUnion("action", [
  z.object({ action: z.literal("transfer"), address: z.string(), confidential: z.boolean(), enabled: z.boolean() }),
  z.object({ action: z.literal("withdraw"), chain: z.literal("near"), address: z.string(), memo: z.string().nullable(), enabled: z.boolean() }),
]);

/**
 * What the agent read from the provider's current policy (`getPolicy`) for one payee. Parsing strips every field it
 * doesn't name, so nothing else of the policy can pass through it.
 */
export const payeeTerms = z.object({
  agentId: z.string(),
  payee: z.string(),
  observedAt: z.iso.datetime(),
  /** The provider's policy revision, its status (`APPLIED` when in force), when it applied and whether the provider is synced. */
  revision: z.number().int().nullable(),
  status: z.string(),
  appliedAt: z.string().nullable(),
  synced: z.boolean(),
  /** Why the policy isn't in force, by the rule the platform refuses sends with; null when it is. */
  notInForce: z.string().nullable(),
  /** Null when no policy is applied. */
  terms: z.object({
    frozen: z.boolean(),
    ownerApproval: z.boolean(),
    /** `only`: the entries are what the owner agreed to pay; `except`: they are exclusions; `any`: every destination. */
    mode: z.enum(["any", "only", "except"]),
    /** An agreed payee: a confidential transfer entry of an `only` policy. */
    agreed: z.boolean(),
    destinations: z.array(payeeDestination),
    /** Per-transaction caps (atomic units, per asset) for the assets the policy lets the agent spend. */
    perTransaction: z.record(z.string(), z.string()),
  }).nullable(),
  /** The mandate digest of the provider's current policy, only when the owner's disclosure opts in and a policy is applied. */
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
});
export type PayeeTerms = z.output<typeof payeeTerms>;

/** The platform's answer: whose disclosure it was read under, and the terms. */
export const payeePolicyProof = z.object({
  host: z.string(),
  owner: z.string(),
  agent: z.string(),
  disclosureExpiresAt: z.iso.datetime(),
  policy: payeeTerms,
});
export type PayeePolicyProof = z.output<typeof payeePolicyProof>;
