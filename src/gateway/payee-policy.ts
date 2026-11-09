import type { IncomingMessage, ServerResponse } from "node:http";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { parsePayeeDisclosureMessage, parsePayeePolicyReadMessage, MAX_PAYEE_READ_MS, PAYEE_POLICY_PATH, payeePolicyRequest, payeeTerms,
  type PayeePolicyProof } from "../contract/payee-policy.js";
import { readJson, sendJson as json } from "../http.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "../nep413.js";
import type { Router } from "../router.js";
import { chainKeyState, clientAddress, hourlyLimit, type KeyStateLookup } from "../signin.js";
import { appendSynced } from "../synced.js";
import { agentOrigin } from "./agent-origin.js";
import { accessLog, MAX_CONSENT_DAYS, privateDirectory } from "./app-access.js";
import type { AgentEntry } from "./config.js";
import { walletOwner, type WalletOwnerRead } from "./wallet-stop.js";

/**
 * A payee's own read of the policy that pays them, with no app in between (`POST /confirm/v1/payee-policy`). The owner's
 * signed payee disclosure and the payee's signed read (src/contract/payee-policy.ts) are both checked: canonical texts
 * naming this host, the same payee and agent, within their lifetimes, valid NEP-413 signatures, and each key a full-access
 * key of its account on chain now. Then the agent must be the owner's wallet-owned agent, still the provider ID the
 * owner named. Only then is the agent asked for that payee's terms, read from the provider's current policy, and only the
 * published fields are answered: the mandate digest only when the owner's signed disclosure opts in. It reads only and stores nothing but a line in the access log.
 */
export type PayeeTermsRead = (agent: AgentEntry, payee: string, digest: boolean) => Promise<unknown>;

/** Reads sent an hour from one address: each costs two chain reads and a provider read. */
const mayRead = hourlyLimit(60);
const DAY = 86_400_000;
class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export async function payeePolicyRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string, root: string, selected: AgentEntry[],
  options: { keyState?: KeyStateLookup; walletOwner?: WalletOwnerRead; readTerms?: PayeeTermsRead; mayUse?: (key: string) => boolean } = {}): Promise<boolean> {
  if (pathname !== PAYEE_POLICY_PATH) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
  if (!(options.mayUse ?? mayRead)(clientAddress(req))) { json(res, 429, { error: "Too many reads from this address. Send it again within the hour." }); return true; }
  const reads = { keyState: options.keyState ?? chainKeyState, walletOwner: options.walletOwner ?? walletOwner, readTerms: options.readTerms ?? agentPayeeTerms };
  try {
    json(res, 200, await prove(await readJson(req), host, root, selected, reads));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    json(res, error.status, { error: error.message });
  }
  return true;
}

async function prove(body: unknown, host: string, root: string, selected: AgentEntry[],
  reads: { keyState: KeyStateLookup; walletOwner: WalletOwnerRead; readTerms: PayeeTermsRead }): Promise<PayeePolicyProof> {
  const request = payeePolicyRequest.safeParse(body);
  if (!request.success) throw new Refused(400, "Send the owner's signed disclosure and the payee's signed read: each message, nonce, publicKey and signature.");
  const { disclosure: signedDisclosure, read: signedRead } = request.data;
  const disclosure = parsePayeeDisclosureMessage(signedDisclosure.message);
  if (!disclosure) throw new Refused(400, "The disclosure text isn't a canonical payee disclosure.");
  if (disclosure.host !== host.toLowerCase()) throw new Refused(400, "The disclosure names another platform host.");
  const read = parsePayeePolicyReadMessage(signedRead.message);
  if (!read) throw new Refused(400, "The read text isn't a canonical payee read.");
  if (read.host !== host.toLowerCase()) throw new Refused(400, "The read names another platform host.");
  if (read.payee !== disclosure.payee || read.agent !== disclosure.agent) throw new Refused(400, "The read names another payee or agent than the disclosure.");
  const now = Date.now(), until = Date.parse(disclosure.expiresAt), readUntil = Date.parse(read.expiresAt);
  if (until <= now) throw new Refused(400, "The disclosure has expired. Ask the owner for a new one.");
  if (until > now + MAX_CONSENT_DAYS * DAY) throw new Refused(400, `A disclosure lasts at most ${MAX_CONSENT_DAYS} days.`);
  if (readUntil <= now) throw new Refused(400, "The read has expired. Sign a new one.");
  if (readUntil > now + MAX_PAYEE_READ_MS) throw new Refused(400, "A read lasts at most an hour after it is signed.");
  if (!signedBy(signedDisclosure, disclosure.host)) throw new Refused(403, "The signature doesn't match the disclosure.");
  if (!signedBy(signedRead, read.host)) throw new Refused(403, "The signature doesn't match the read.");

  let keys: Awaited<ReturnType<KeyStateLookup>>[];
  try { keys = await Promise.all([reads.keyState(disclosure.owner, signedDisclosure.publicKey), reads.keyState(read.payee, signedRead.publicKey)]); }
  catch { throw new Refused(503, "A key couldn't be checked now. Nothing was read; send it again."); }
  if (keys[0] !== "FullAccess") throw new Refused(403, `${signedDisclosure.publicKey} is not a full-access key of ${disclosure.owner}.`);
  if (keys[1] !== "FullAccess") throw new Refused(403, `${signedRead.publicKey} is not a full-access key of ${read.payee}.`);

  const absent = new Refused(404, `No agent of ${disclosure.owner} named ${disclosure.agent} on this host.`);
  const replaced = new Refused(409, `The agent ${disclosure.agent} was replaced or isn't created: the disclosure names ${disclosure.agentId}. Ask the owner for a new one.`);
  const entry = selected.find(a => a.name === disclosure.agent && a.owner === disclosure.owner);
  if (!entry) throw absent;
  let owned: Awaited<ReturnType<WalletOwnerRead>>;
  try { owned = await reads.walletOwner(disclosure.owner, entry); }
  catch { throw new Refused(503, "The agent's ownership couldn't be checked now. Nothing was read; send it again."); }
  if (!owned) throw absent;
  if (owned.agentId !== disclosure.agentId) throw replaced;

  let answer: unknown;
  const discloseDigest = disclosure.discloseDigest === true;
  try { answer = await reads.readTerms(entry, read.payee, discloseDigest); }
  catch { throw new Refused(503, "The agent's policy couldn't be read now. Send it again."); }
  // Parsing keeps only the published fields: nothing else of the policy can pass.
  const terms = payeeTerms.safeParse(answer);
  if (!terms.success || terms.data.payee !== read.payee) throw new Refused(503, "The agent's policy couldn't be read now. Send it again.");
  if (terms.data.agentId !== disclosure.agentId) throw replaced;
  // The digest only under the owner's opt-in, whatever the agent answered.
  const { digest, ...published } = terms.data;
  const policy = discloseDigest && digest ? { ...published, digest } : published;

  privateDirectory(root);
  appendSynced(accessLog(root), { at: new Date(now).toISOString(), event: "payee-policy", owner: disclosure.owner, agent: disclosure.agent,
    payee: read.payee, revision: terms.data.revision });
  return { host: disclosure.host, owner: disclosure.owner, agent: disclosure.agent, disclosureExpiresAt: disclosure.expiresAt, policy };
}

/** Whether a submission is a NEP-413 signature over its message, recipient `host`, by the key it names. */
function signedBy({ message, nonce, publicKey, signature }: { message: string; nonce: string; publicKey: string; signature: string }, host: string) {
  try { return verifyEd25519(publicKey, nep413Hash(message, Buffer.from(nonce, "base64"), host), signatureBytes(signature)); }
  catch { return false; }
}

/** The agent's own `payeeTerms`, a gateway-only read. */
function agentPayeeTerms(agent: AgentEntry, payee: string, digest: boolean) {
  const client: RouterClient<Router> = createORPCClient(new RPCLink({ origin: agentOrigin(agent), url: "/rpc", headers: { "x-gateway": "payee-policy" } }));
  return client.payeeTerms({ payee, digest }, { signal: AbortSignal.timeout(5_000) });
}
