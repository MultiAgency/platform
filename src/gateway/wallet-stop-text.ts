import { z } from "zod";
import { appConsent } from "../contract/app-consent.js";

/**
 * A wallet owner's own stop, with no app involved: signed with NEP-413 (recipient the platform host) on the platform's
 * stop page, or by any tool that signs NEP-413. It names one agent, or `"*"` for every agent the wallet owns on the
 * host. Applied, it ends every app consent for them given before it is applied and turns their autopilot off. It only
 * removes authority. Pure, so the stop page builds the same text the gateway checks.
 */
export const WALLET_STOP_TYPE = "multiagency.wallet-stop";
/** Every agent the signing wallet owns on the host. Not a valid agent name, so it never names one. */
export const EVERY_AGENT = "*";
/** How long a signed stop may wait to be applied: it is signed to be applied now. */
export const MAX_WALLET_STOP_MS = 3_600_000;

export const walletStop = z.strictObject({
  type: z.literal(WALLET_STOP_TYPE),
  version: z.literal(1),
  host: appConsent.shape.host,
  owner: appConsent.shape.owner,
  agent: z.union([z.literal(EVERY_AGENT), appConsent.shape.agent]),
  expiresAt: z.iso.datetime(),
});
export type WalletStop = z.output<typeof walletStop>;

/** The canonical text to sign: fixed key order, no whitespace. */
export function walletStopMessage(stop: Omit<WalletStop, "type" | "version">): string {
  const value = walletStop.parse({ type: WALLET_STOP_TYPE, version: 1, ...stop });
  return JSON.stringify({ type: value.type, version: value.version, host: value.host, owner: value.owner, agent: value.agent, expiresAt: value.expiresAt });
}

/** The stop a signed text states, or null unless the text is exactly its canonical form. */
export function parseWalletStopMessage(message: string): WalletStop | null {
  let value: unknown;
  try { value = JSON.parse(message); } catch { return null; }
  const parsed = walletStop.safeParse(value);
  if (!parsed.success) return null;
  const { type: _type, version: _version, ...fields } = parsed.data;
  return walletStopMessage(fields) === message ? parsed.data : null;
}
