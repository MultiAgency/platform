import { z } from "zod";

/**
 * An agent owner's consent for one app deployment to act for one Organization on one agent: `read` for the listed
 * reads, `owner` to prepare and submit owner actions that only the owner's own wallet signature completes.
 * The owner signs `consentMessage(...)` with NEP-413, recipient the platform host. The platform accepts only the exact
 * canonical text, so what was signed and what is stored are the same bytes.
 */
export const APP_CONSENT_TYPE = "multiagency.app-consent";
export const AppScope = z.enum(["owner", "payout", "read"]);
export type AppScope = z.infer<typeof AppScope>;
const name = z.string().regex(/^[a-z0-9-]{1,32}$/);
/** Stands for an agent its server reports not created yet; only the platform's setup consent carries it, never a signed text. */
export const UNBORN_AGENT = "unborn";
const account = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const appConsent = z.strictObject({
  type: z.literal(APP_CONSENT_TYPE),
  version: z.literal(1),
  host: z.string().min(1).max(253).regex(/^[a-z0-9.-]+(?::\d{1,5})?$/),
  deployment: name,
  organization: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  owner: account,
  agent: name,
  /** The agent's provider ID when the owner signs: a replacement agent under the same name isn't covered. */
  agentId: z.string().min(1).max(128).refine(id => id !== UNBORN_AGENT, "Not an agent ID"),
  scopes: z.array(AppScope).min(1).refine(values => new Set(values).size === values.length, "Scopes must be distinct"),
  expiresAt: z.iso.datetime(),
});
export type AppConsent = z.output<typeof appConsent>;

/** The canonical text to sign: fixed key order, sorted scopes, no whitespace. */
export function consentMessage(consent: Omit<AppConsent, "type" | "version">): string {
  const value = appConsent.parse({ type: APP_CONSENT_TYPE, version: 1, ...consent });
  return JSON.stringify({ type: value.type, version: value.version, host: value.host, deployment: value.deployment,
    organization: value.organization, owner: value.owner, agent: value.agent, agentId: value.agentId, scopes: [...value.scopes].sort(), expiresAt: value.expiresAt });
}

/** The consent a signed text states, or null unless the text is exactly its canonical form. */
export function parseConsentMessage(message: string): AppConsent | null {
  let value: unknown;
  try { value = JSON.parse(message); } catch { return null; }
  const parsed = appConsent.safeParse(value);
  if (!parsed.success) return null;
  const { type: _type, version: _version, ...fields } = parsed.data;
  return consentMessage(fields) === message ? parsed.data : null;
}

/** What the app submits after the owner signs: the text, the NEP-413 nonce (32 bytes, base64) and the signature. */
export const appConsentSubmission = z.strictObject({
  message: z.string().min(1).max(2_048),
  nonce: z.string().min(1).max(64),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  signature: z.string().min(1).max(200),
});

/**
 * An agent owner's request, signed with NEP-413 like a consent, that the platform set up a hosted agent for this owner
 * and area and let the app prepare its creation. It lasts at most an hour: it authorizes a setup, not ongoing
 * access. Once the agent exists, the app asks for a consent naming its provider ID.
 */
export const APP_SETUP_TYPE = "multiagency.app-setup";
export const appSetup = z.strictObject({
  type: z.literal(APP_SETUP_TYPE),
  version: z.literal(1),
  host: appConsent.shape.host,
  deployment: name,
  organization: appConsent.shape.organization,
  owner: account,
  area: z.enum(["treasury", "payables"]),
  expiresAt: z.iso.datetime(),
});
export type AppSetup = z.output<typeof appSetup>;

/** The canonical setup text to sign: fixed key order, no whitespace. */
export function setupMessage(setup: Omit<AppSetup, "type" | "version">): string {
  const value = appSetup.parse({ type: APP_SETUP_TYPE, version: 1, ...setup });
  return JSON.stringify({ type: value.type, version: value.version, host: value.host, deployment: value.deployment,
    organization: value.organization, owner: value.owner, area: value.area, expiresAt: value.expiresAt });
}

/** The setup a signed text states, or null unless the text is exactly its canonical form. */
export function parseSetupMessage(message: string): AppSetup | null {
  let value: unknown;
  try { value = JSON.parse(message); } catch { return null; }
  const parsed = appSetup.safeParse(value);
  if (!parsed.success) return null;
  const { type: _type, version: _version, ...fields } = parsed.data;
  return setupMessage(fields) === message ? parsed.data : null;
}
