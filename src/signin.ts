import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Near } from "near-kit";
import { mainnet } from "./chain.js";
import { BadRequest } from "./http.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "./nep413.js";

/**
 * Sign-in with a NEAR wallet: the server issues a single-use nonce, the wallet signs a NEP-413
 * message bound to this host, and the server checks the signature, then that the key is a full-access
 * key of the account it claims. A session is an HMAC-signed cookie naming the account. What the
 * account may do is the caller's decision, made per request (the DAO gateway reads the DAO's policy),
 * never stored in the session.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;

const signInMessage = (host: string) => `Sign in to ${host}`;

/** Nonces issued and not yet used, with when each expires. */
const challenges = new Map<string, number>();
/**
 * The client's address for rate limits. Behind a proxy that sets X-Forwarded-For (TRUST_PROXY=true,
 * e.g. Railway) it is the last entry, the one the proxy appended; earlier entries are whatever the
 * client sent.
 */
export const clientAddress = (req: IncomingMessage) =>
  (process.env.TRUST_PROXY === "true" && String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)?.trim()) ||
  req.socket.remoteAddress || "unknown";

/** A per-key hourly limit. Once there are many keys, idle ones are forgotten, so distinct callers can't grow memory without bound. */
export function hourlyLimit(perHour: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()) => {
    if (hits.size > 10_000) for (const [k, times] of hits) if (now - (times.at(-1) ?? 0) >= 3_600_000) hits.delete(k);
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= perHour) return false;
    hits.set(key, [...recent, now]);
    return true;
  };
}

/** The most open challenges at once, so a flood of requests can't grow memory without bound. */
export const MAX_CHALLENGES = 10_000;
export class ChallengeLimit extends Error {
  constructor() { super("Too many sign-ins in progress. Try again in a few minutes."); }
}

export function issueChallenge(host: string, now = Date.now()) {
  for (const [nonce, expires] of challenges) if (expires <= now) challenges.delete(nonce);
  if (challenges.size >= MAX_CHALLENGES) throw new ChallengeLimit();
  const nonce = randomBytes(32).toString("base64");
  challenges.set(nonce, now + CHALLENGE_TTL_MS);
  return { message: signInMessage(host), recipient: host, nonce };
}

/**
 * What a wallet's signMessage returns, plus the nonce. Some wallets also sign a callbackUrl, which
 * they fill in themselves (the page that asked) and don't report back: the page sends what it might
 * have been, in `callbackUrls`, and `callbackUrl` when it knows.
 */
type SignIn = {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
  callbackUrl?: string | null;
  callbackUrls?: string[];
};

/** Looks up a key: its permission, or null if the account has no such key. */
export type KeyLookup = (accountId: string, publicKey: string) => Promise<"FullAccess" | "FunctionCall" | null>;

const near = new Near(mainnet);

/**
 * The key as NEAR mainnet has it now (`view_access_key`). near-kit answers null for any RPC error too
 * (near-kit/dist/core/near.js getAccessKey), so an outage refuses the sign-in as an unknown key.
 */
export const chainKeyLookup: KeyLookup = async (accountId, publicKey) => {
  const key = await near.getAccessKey(accountId, publicKey);
  if (!key) return null;
  return key.permission === "FullAccess" ? "FullAccess" : "FunctionCall";
};

/** A key's standing on chain. Only an answer the chain gave decides; anything else throws, never "absent". */
export type KeyState = "FullAccess" | "FunctionCall" | "absent";
export type KeyStateLookup = (accountId: string, publicKey: string) => Promise<KeyState>;

/**
 * `view_access_key` at final finality, read directly so a missing key is told apart from a failed request (near-kit's
 * `getAccessKey` answers null for both). A missing key arrives as `result.error` "... does not exist ..." or as an
 * UNKNOWN_ACCESS_KEY / UNKNOWN_ACCOUNT error cause.
 */
export const chainKeyState: KeyStateLookup = async (accountId, publicKey) => {
  const response = await fetch(mainnet.network.rpcUrl, { method: "POST", signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json", ...mainnet.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: "key-state", method: "query",
      params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }) });
  if (!response.ok) throw new Error(`NEAR RPC answered ${response.status}`);
  const body = await response.json() as { result?: { permission?: unknown; error?: unknown }; error?: { cause?: { name?: unknown } } };
  const cause = body.error?.cause?.name;
  if (cause === "UNKNOWN_ACCESS_KEY" || cause === "UNKNOWN_ACCOUNT") return "absent";
  if (typeof body.result?.error === "string" && body.result.error.includes("does not exist")) return "absent";
  const permission = body.result?.permission;
  if (permission === "FullAccess") return "FullAccess";
  if (permission && typeof permission === "object" && "FunctionCall" in permission) return "FunctionCall";
  throw new Error("NEAR RPC gave no key answer");
};

/** The account a sign-in proves, or an error saying why it doesn't. The nonce is spent either way. */
export async function verifySignIn(
  { accountId, publicKey, signature, nonce, callbackUrl, callbackUrls = [] }: SignIn,
  host: string,
  lookup: KeyLookup,
  now = Date.now(),
) {
  const expires = challenges.get(nonce);
  challenges.delete(nonce);
  if (expires === undefined) throw new Error("Unknown or used sign-in challenge: start again");
  if (expires <= now) throw new Error("The sign-in challenge expired: start again");
  // A callback the wallet signed must be this site too, so the signature stays bound to it.
  const offered = callbackUrl === undefined ? [null, ...callbackUrls] : [callbackUrl];
  if (offered.length > 4) throw new Error("Too many callback URLs");
  if (offered.some((url) => url !== null && URL.parse(url)?.host !== host)) throw new Error("The signed callback URL is not this site");
  const bytes = signatureBytes(signature);
  const signed = offered.some((url) =>
    verifyEd25519(publicKey, nep413Hash(signInMessage(host), Buffer.from(nonce, "base64"), host, url), bytes),
  );
  if (!signed) throw new Error("The signature doesn't match this challenge");
  const permission = await lookup(accountId, publicKey);
  if (permission === null) throw new Error(`${publicKey} is not a key of ${accountId}`);
  if (permission !== "FullAccess") throw new Error("Sign in with a full-access key of the account");
  return accountId;
}

/**
 * A sign-in request's body, checked: the four signed fields as strings, and at most three callback
 * URLs the page offers (some wallets sign the page's URL as NEP-413's callbackUrl without saying so).
 */
export function parseSignIn(body: Record<string, unknown>): SignIn {
  const { accountId, publicKey, signature, nonce } = body;
  if (typeof accountId !== "string" || typeof publicKey !== "string" || typeof signature !== "string" || typeof nonce !== "string")
    throw new BadRequest("Sign in with your wallet.");
  const callbackUrls = Array.isArray(body.callbackUrls) ? body.callbackUrls.filter((u): u is string => typeof u === "string").slice(0, 3) : [];
  return { accountId, publicKey, signature, nonce, callbackUrls };
}

/** The answer to a request for a sign-in challenge: a fresh one, or 429 while a limit is reached. */
export function challengeAnswer(host: string, allowed: boolean): [number, object] {
  if (!allowed) return [429, { error: "Too many sign-in attempts. Try again later." }];
  try {
    return [200, issueChallenge(host)];
  } catch (error) {
    if (error instanceof ChallengeLimit) return [429, { error: error.message }];
    throw error;
  }
}

const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** A session cookie value: `<account>.<expiry ms>.<hmac>`. */
export function sessionToken(accountId: string, secret: string, now = Date.now()) {
  const payload = `${Buffer.from(accountId).toString("base64url")}.${now + SESSION_TTL_MS}`;
  return `${payload}.${mac(secret, payload)}`;
}

/** The account a session cookie names, or null if it was forged, altered or has expired. */
export function sessionAccount(token: string | undefined, secret: string, now = Date.now()) {
  const [account, expires, signature] = token?.split(".") ?? [];
  if (!account || !expires || !signature) return null;
  const expected = Buffer.from(mac(secret, `${account}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(expires) <= now) return null;
  return Buffer.from(account, "base64url").toString();
}

/**
 * One app's sessions, under its own cookie name so a session from another app on the same domain never
 * counts. `open` and `close` return the set-cookie header to answer with.
 */
export function sessions({ cookie, secret, secure }: { cookie: string; secret: string; secure: boolean }) {
  const header = (value: string, maxAgeS: number) =>
    `${cookie}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
  return {
    /** The signed-in account, or null. */
    account: (req: IncomingMessage) =>
      sessionAccount(req.headers.cookie?.split(";").map((c) => c.trim().split("=")).find(([name]) => name === cookie)?.[1], secret),
    open: (accountId: string) => header(sessionToken(accountId, secret), SESSION_TTL_MS / 1000),
    close: () => header("", 0),
  };
}
