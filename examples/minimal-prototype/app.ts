// A new prototype on a Proto host: presentation only. Every call is same-origin through the gateway; this page holds
// no credentials, grants or callback channel, and the wallet signs every owner action.
import { NearConnector } from "@fastnear/near-connect";
import { gatewayDiscovery, ownerClient, type OwnerFailure, type OwnerOutput } from "@multiagency/sdk";

type Action = "agent_freeze" | "agent_unfreeze";
/** The owner action this page is following. Kept before signing, so a lost reply or a reload never loses its id. */
type Retained = { correlationId: string; type: Action; phase: "prepared" | "submitting" };

const AGENT = location.pathname.match(/^\/a\/([a-z0-9-]+)/)?.[1] ?? "payout";
const owner = ownerClient({ base: `/a/${AGENT}` });
const connector = new NearConnector({ network: "mainnet", features: { signMessage: true },
  manifest: "https://cdn.jsdelivr.net/gh/fastnear/near-connect@d277b41263a8ea0a6892236b22824d46c2c3c377/repository/manifest.json" });
const $ = (id: string) => document.getElementById(id) as HTMLElement & { disabled: boolean };
const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const say = (text: string) => { $("action").textContent = text; };

const KEY = `minimal-prototype:${AGENT}:owner-action`;
function retained(): Retained | undefined {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") ?? undefined; } catch { return undefined; }
}
/** Throws when the id can't be kept: the caller then stops before signing or submitting. */
const retain = (action: Retained) => localStorage.setItem(KEY, JSON.stringify(action));
const release = () => { try { localStorage.removeItem(KEY); } catch { /* the next follow reads the record again */ } };
/** This page's own action, from the click on: before prepare answers nothing is kept yet, and while it waits for the
 * wallet its kept record is still `prepared`. Neither a read nor a resume may treat it as absent or abandoned. */
let acting = false;

const access = (failure: OwnerFailure) => failure.kind === "session" ? "Sign in to continue."
  : failure.kind === "forbidden" ? "This account may not do that here." : undefined;

async function signIn() {
  await connector.connect();
  const { wallet } = await connector.getConnectedWallet();
  const challenge = await (await fetch("/gw/challenge")).json() as { message: string; recipient: string; nonce: string };
  const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: fromBase64(challenge.nonce) });
  if (!signed) throw new Error("Not signed");
  const session = await fetch("/gw/session", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }) });
  if (!session.ok) throw new Error(`Sign-in refused (${session.status})`);
  await start();
}

/** Who is signed in, from the gateway's discovery answer (validated against the SDK schema). */
async function signedInAccount() {
  const response = await fetch("/gw/me");
  const discovery = gatewayDiscovery.safeParse(await response.json().catch(() => null));
  return discovery.success ? discovery.data.viewer?.account : undefined;
}

async function read() {
  const overview = await owner.call("overview");
  if (!overview.ok) {
    $("agent").textContent = access(overview) ?? "The agent could not be read. Read again; reading is safe.";
    return;
  }
  const policy = overview.value.policy.policy;
  $("agent").textContent = policy?.frozen ? "Paused by its owner." : overview.value.notInForce ? `Not in force: ${overview.value.notInForce}` : "Active.";
  $("refresh").disabled = false;
  const following = acting || Boolean(retained());
  $("freeze").disabled = following || Boolean(policy?.frozen);
  $("unfreeze").disabled = following || !policy?.frozen;
}

type OwnerAction = OwnerOutput<"owner/actions">[number];
/**
 * Follows the retained action by its correlationId until it is settled. Reads only: it never signs or submits again.
 * A record that isn't listed yet, or a failed read, keeps the action retained; neither proves it had no effect.
 */
async function follow(action: Retained) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const actions = await owner.call("owner/actions");
    const record: OwnerAction | undefined = actions.ok ? actions.value.find(a => a.correlationId === action.correlationId) : undefined;
    if (!actions.ok) say(`${access(actions) ?? "The action's record could not be read."} Still following it; do not sign again.`);
    else if (record?.stage === "settled") {
      release();
      say(record.status === "SUCCESS" ? "Signed and recorded." : `Not applied (${record.status ?? "no status"}). Review the recorded action before trying again.`);
      return;
    } else if (record?.stage === "submitted") say("Signature submitted; waiting for the recorded outcome. Do not sign again.");
    else if (record && action.phase === "prepared") {
      // This page never submitted it, and an owner action has no effect until it is submitted.
      release();
      say("Prepared but never submitted, so it had no effect. You can start again.");
      return;
    } else if (record?.stage === "expired") {
      release();
      say("Expired without a recorded submission. You can start again.");
      return;
    } else say("The submission's outcome isn't recorded yet. Still following it; do not sign again.");
    await wait(500);
  }
  say(`Still following owner action ${action.correlationId}. Reload or read again later; do not sign again.`);
}

/** Prepare once, keep its id, show what will be signed, sign in the wallet, submit once, then follow the same record. */
async function ownerAction(type: Action) {
  if (acting || retained()) { say("An earlier owner action is still being followed."); return; }
  acting = true;
  for (const id of ["freeze", "unfreeze"]) $(id).disabled = true;
  try {
    const prepared = await owner.call("owner/prepare", { action: { type }, signer: "wallet" });
    if (!prepared.ok) {
      say(prepared.kind === "unknown"
        // No correlationId came back, so there is nothing this page can follow.
        ? "The preparation's answer was lost, so this page has no id to follow it by. Nothing was signed or submitted; a prepared action has no effect until it is. Read the agent before trying again."
        : access(prepared) ?? ("error" in prepared ? prepared.error : "The action could not be prepared."));
      return;
    }
    const { correlationId, intent, preview } = prepared.value;
    if (!intent || intent.standard !== "nep413") { say("This action needs a wallet signature this page can't request."); return; }
    try { retain({ correlationId, type, phase: "prepared" }); } catch { say("This page couldn't keep the action's id, so it didn't ask you to sign."); return; }
    say(`Approve in your wallet: ${preview.summary}.`);
    const { wallet } = await connector.getConnectedWallet();
    const payload = intent.payload as { message: string; recipient: string; nonce: string };
    let signed;
    try { signed = await wallet.signMessage({ ...payload, nonce: fromBase64(payload.nonce) }); } catch { signed = undefined; }
    if (!signed) { release(); say("Not signed, so nothing was submitted."); return; }
    try { retain({ correlationId, type, phase: "submitting" }); } catch { release(); say("This page couldn't keep the action's id, so it didn't submit your signature."); return; }
    const submitted = await owner.call("owner/submit", { correlationId, signedData: { ...intent, public_key: signed.publicKey, signature: signed.signature } });
    if (!submitted.ok) say(submitted.kind === "unknown"
      ? "The submission's answer was lost. Following the same action; do not sign again."
      : `${access(submitted) ?? ("error" in submitted ? submitted.error : "The submission failed.")} Checking the recorded action.`);
    await follow({ correlationId, type, phase: "submitting" });
  } finally {
    acting = false;
    await read();
  }
}

/** On load and after sign-in: read the agent, and resume following an action kept before a reload. */
async function start() {
  const account = await signedInAccount();
  if (!account) return;
  $("account").textContent = `Signed in as ${account}.`;
  await read();
  const action = retained();
  // A sign-in during this page's own action leaves that action to follow itself.
  if (action && !acting) { await follow(action); await read(); }
}

$("signin").onclick = () => signIn().catch(() => { $("account").textContent = "Sign-in failed. Try again."; });
$("refresh").onclick = read;
$("freeze").onclick = () => ownerAction("agent_freeze");
$("unfreeze").onclick = () => ownerAction("agent_unfreeze");
void start();
