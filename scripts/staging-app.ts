// A local app stand-in for platform staging (step 8 of the platform staging walkthrough): it holds the app deployment's
// service credential on this machine and has the owner's wallet sign app texts in a localhost page. Test tooling only:
// never deployed, never given to anyone else. Usage (from the repository root):
//   PLATFORM_URL=https://api.dev.multiagency.ai PLATFORM_APP_CREDENTIAL=tap_… PLATFORM_DEPLOYMENT=staging \
//   ORGANIZATION=org_step8 pnpm exec tsx scripts/staging-app.ts
// then open http://127.0.0.1:4318/. The credential stays in this process; the page never sees it.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { appClient, consentMessage, setupMessage, type AppOwnerAction, type AppProcedure } from "../src/contract/index.js";

const base = process.env.PLATFORM_URL as `https://${string}` | undefined;
const credential = process.env.PLATFORM_APP_CREDENTIAL, deployment = process.env.PLATFORM_DEPLOYMENT ?? "staging";
const organization = process.env.ORGANIZATION ?? "org_step8", port = Number(process.env.PORT ?? 4318);
if (!base?.startsWith("https://") || !credential?.startsWith("tap_")) throw new Error("Set PLATFORM_URL (https://…) and PLATFORM_APP_CREDENTIAL (tap_…)");
const host = new URL(base).host;
const app = appClient({ base, credential });
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

/** What the page may ask for. Each answer is the platform's answer, unchanged; texts to sign name this host. */
const ops: Record<string, (input: Record<string, any>) => Promise<unknown>> = {
  config: async () => ({ host, deployment, organization }),
  setupText: async ({ owner, area }) => ({ message: setupMessage({ host, deployment, organization, owner, area, expiresAt: later(30 * 60_000) }) }),
  setup: async ({ submission }) => app.setup(submission),
  identity: async ({ agent }) => app.identity(agent),
  consentText: async ({ agent, scopes }) => {
    const identity = await app.identity(agent);
    if (!identity.ok || !identity.value.agentId) return { error: "Not created yet, or identity unreadable", identity };
    return { message: consentMessage({ host, deployment, organization, owner: identity.value.owner, agent, agentId: identity.value.agentId,
      scopes, expiresAt: later(30 * 86_400_000) }) };
  },
  consent: async ({ submission }) => app.consents.submit(submission),
  consents: async () => app.consents.list(organization),
  /** A call to one agent's procedure through the app's consent; `expectedPolicy: "current"` is filled from overview. */
  call: async ({ agent, path, input }) => {
    const agentCalls = app.agent(organization, agent);
    const call = agentCalls.call as (path: AppProcedure, input?: unknown) => Promise<unknown>;
    if (input?.expectedPolicy === "current" || input?.action?.expectedPolicy === "current") {
      const overview = await agentCalls.call("overview") as { ok: boolean; value?: { policy: { revision: number }; digest: string } };
      if (!overview.ok) return overview;
      const reviewed = { revision: overview.value!.policy.revision, digest: overview.value!.digest };
      input = input.action ? { ...input, action: { ...input.action, expectedPolicy: reviewed } as AppOwnerAction } : { ...input, expectedPolicy: reviewed };
    }
    return call(path as AppProcedure, input);
  },
};

// The wallet connector is served from this repository's installed copy, not a CDN: only this process's scripts run in
// the page's origin, which can drive every operation above.
const NEAR_CONNECT = readFileSync(join(import.meta.dirname, "../node_modules/@fastnear/near-connect/cdn/hot-connect.es.js"));
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; frame-src https:; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const read = async (req: IncomingMessage) => { let text = ""; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(421).end(); return; }
    if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP }).end(PAGE); return; }
    if (req.method === "GET" && req.url === "/near-connect.js") { res.writeHead(200, { "content-type": "text/javascript" }).end(NEAR_CONNECT); return; }
    const op = req.method === "POST" && req.url?.startsWith("/api/") ? ops[req.url.slice(5)] : undefined;
    if (!op) { res.writeHead(404).end(); return; }
    // Only this page: a cross-site page can't make this process act with the credential.
    if (req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    const answer = await op(await read(req));
    console.log(req.url, JSON.stringify(answer).slice(0, 400));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer, (_k, v) => typeof v === "bigint" ? v.toString() : v));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`Step 8 app stand-in for ${host} (deployment ${deployment}, Organization ${organization}): http://127.0.0.1:${port}/`));

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Step 8 app stand-in</title>
<style>body{font:15px/1.5 system-ui;max-width:52rem;margin:2rem auto;padding:0 1rem}fieldset{margin:1rem 0}input{width:22rem}pre{background:#f4f4f4;padding:.5rem;white-space:pre-wrap;word-break:break-all}</style>
<h1>Step 8 app stand-in</h1><p id="config"></p>
<p><button id="connect">Connect wallet</button> <span id="account"></span></p>
<fieldset><legend>1. Set up the Organization's payout agent</legend><button data-run="setup">Sign setup text and submit</button>
 Agent: <input id="agent" placeholder="filled by setup"></fieldset>
<fieldset><legend>2. Owner actions (a NEP-413 intent is signed here; a NEP-366 one opens the platform's confirm page)</legend>
<button data-run="create">Create the agent</button> <button data-run="consent">Sign consent (owner, payout, read)</button>
<button data-run="grant">Issue payout grant</button><br>Payee: <input id="payee" placeholder="payee.near"> <button data-run="payee">Add payee</button>
<button data-run="freeze">Freeze</button> <button data-run="unfreeze">Unfreeze</button><br>Correlation ID: <input id="correlation"> <button data-run="status">Owner status</button></fieldset>
<fieldset><legend>3. Withdrawals to a NEAR account (each a policy edit on the confirm page)</legend>
<button data-run="withdrawals">Agree payee for withdrawal</button> wNEAR cap per payout, day and month (yoctoNEAR): <input id="wnearCap" placeholder="100000000000000000000000">
<button data-run="allowNear">Allow wNEAR</button><br><button data-run="approvalOff">Owner approval off (auto-pay)</button> <button data-run="approvalOn">Owner approval on</button></fieldset>
<fieldset><legend>4. Payout request and vote</legend>Asset: <select id="asset"><option value="USDC">USDC (6 decimals)</option><option value="wNEAR">wNEAR (24 decimals)</option></select>
 Delivery: <select id="delivery"><option value="intents">intents (confidential transfer)</option><option value="near">withdraw to chain near</option></select>
<br>Request ID: <input id="requestId" placeholder="step8-1"><br>Amount (base units): <input id="amount" placeholder="100000">
<br><button data-run="fund">Deposit address</button> <button data-run="pay">Request payout</button> <button data-run="payStatus">Payout status</button> <button data-run="held">Held</button> <button data-run="vote">Vote approve on the held payout</button> <button data-run="reject">Vote reject</button></fieldset>
<pre id="out"></pre>
<script type="module">
import { NearConnector } from "/near-connect.js";
const ASSETS = { USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", wNEAR: "nep141:wrap.near" };
const asset = () => ASSETS[$("asset").value];
const $ = id => document.getElementById(id), out = v => { $("out").textContent = JSON.stringify(v, null, 2); return v; };
const api = async (op, input = {}) => (await fetch("/api/" + op, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).json();
const config = await api("config");
$("config").textContent = "Platform " + config.host + ", app deployment " + config.deployment + ", Organization " + config.organization;
const connector = new NearConnector({ network: "mainnet", features: { signMessage: true } });
// The owner key that signed the setup: the platform creates the agent only for that key (some wallets report no key on connect).
let account, setupKey;
$("connect").onclick = async () => { await connector.connect(); account = (await connector.getConnectedWallet()).accounts[0]; $("account").textContent = account.accountId; };
const wallet = async () => (await connector.getConnectedWallet()).wallet;
const b64 = bytes => btoa(String.fromCharCode(...bytes)), unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
/** The owner signs an app text (recipient: the platform host) and the platform gets the submission. */
async function signText(message) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signed = await (await wallet()).signMessage({ message, recipient: config.host, nonce });
  return { message, nonce: b64(nonce), publicKey: signed.publicKey, signature: signed.signature };
}
/**
 * Prepares an owner action: a readable intent is signed and submitted here; otherwise the confirm page opens. The check
 * may refuse the prepared answer before the wallet is asked.
 */
async function owner(action, check = () => null) {
  const prepared = out(await api("call", { agent: $("agent").value, path: "owner/prepare", input: { action, signer: "wallet" } }));
  if (!prepared.ok) return;
  const refusal = check(prepared.value);
  if (refusal) return out({ refused: refusal, prepared: prepared.value });
  $("correlation").value = prepared.value.correlationId;
  if (prepared.value.confirm) { window.open(prepared.value.confirm.url, "_blank"); return; }
  const { intent } = prepared.value;
  const signed = await (await wallet()).signMessage({ ...intent.payload, nonce: unb64(intent.payload.nonce) });
  out({ prepared: prepared.value.payment ?? null, submitted: await api("call", { agent: $("agent").value, path: "owner/submit",
    input: { correlationId: prepared.value.correlationId, signedData: { ...intent, public_key: signed.publicKey, signature: signed.signature } } }) });
}
/** Votes on this request's held payout. */
async function vote(verdict) {
  const held = await api("call", { agent: $("agent").value, path: "held" });
  const status = await api("call", { agent: $("agent").value, path: "payouts/status", input: { requestId: $("requestId").value } });
  const entry = held.ok && status.ok && held.value.find(h => h.correlationId === status.value.correlationId);
  if (!entry) return out({ error: "No held payout for this request ID", held, status });
  // The vote's own text names no payee or amount: approving checks the terms the platform proved against this request.
  // Rejecting releases nothing, so it carries no terms.
  await owner({ type: "approval_vote", approvalId: entry.approvalId, verdict, correlationId: entry.correlationId }, prepared => {
    if (verdict === "reject") return null;
    const terms = prepared.payment?.terms;
    return terms && terms.recipient === $("payee").value && terms.amount === $("amount").value && terms.asset === asset() ? null
      : "The proven terms don't match this request's payee, amount and asset. Not signed.";
  });
}
const runs = {
  setup: async () => {
    const { message } = await api("setupText", { owner: account.accountId, area: "payables" });
    const submission = await signText(message);
    const r = out(await api("setup", { submission }));
    if (r.ok) { $("agent").value = r.value.agent; setupKey = submission.publicKey; }
  },
  create: () => owner({ type: "agent_create", owner: { type: "near", account_id: account.accountId, public_key: setupKey ?? account.publicKey }, role: "payout" }),
  consent: async () => { const text = await api("consentText", { agent: $("agent").value, scopes: ["owner", "payout", "read"] }); if (!text.message) return out(text); out(await api("consent", { submission: await signText(text.message) })); },
  grant: () => owner({ type: "grant_issue", label: "payout" }),
  payee: () => owner({ type: "policy_update", expectedPolicy: "current", changes: { destinations: [{ address: $("payee").value, confidential: true }] } }),
  withdrawals: () => owner({ type: "policy_update", expectedPolicy: "current", changes: { withdrawals: [{ address: $("payee").value }] } }),
  // Adds wNEAR to the assets and caps it per payout, day and month, keeping every other cap (an edit replaces \`limits\` whole).
  allowNear: async () => {
    const overview = await api("call", { agent: $("agent").value, path: "overview" });
    const policy = overview.ok && overview.value.policy.policy;
    if (!policy || !/^[1-9][0-9]*$/.test($("wnearCap").value)) return out({ error: "Needs the agent's policy and a wNEAR cap", overview });
    if (!Array.isArray(policy.assets)) return out({ error: "This policy allows any asset; nothing to add", policy });
    const cap = $("wnearCap").value, limits = { ...policy.limits };
    for (const window of ["per_transaction", "daily", "monthly"]) limits[window] = { ...limits[window], [ASSETS.wNEAR]: cap };
    await owner({ type: "policy_update", expectedPolicy: "current", changes: { assets: [...new Set([...policy.assets, ASSETS.wNEAR])], limits } });
  },
  approvalOff: () => owner({ type: "policy_update", expectedPolicy: "current", changes: { owner_approval: false } }),
  approvalOn: () => owner({ type: "policy_update", expectedPolicy: "current", changes: { owner_approval: true } }),
  freeze: () => owner({ type: "agent_freeze" }), unfreeze: () => owner({ type: "agent_unfreeze" }),
  status: async () => out(await api("call", { agent: $("agent").value, path: "owner/status", input: { correlationId: $("correlation").value } })),
  fund: async () => out(await api("call", { agent: $("agent").value, path: "deposit", input: { asset: asset() } })),
  pay: async () => out(await api("call", { agent: $("agent").value, path: "payouts/request", input: { requestId: $("requestId").value, asset: asset(),
    delivery: $("delivery").value === "near" ? { chain: "near" } : "intents", recipient: $("payee").value, amount: $("amount").value, expectedPolicy: "current" } })),
  payStatus: async () => out(await api("call", { agent: $("agent").value, path: "payouts/status", input: { requestId: $("requestId").value } })),
  held: async () => out(await api("call", { agent: $("agent").value, path: "held" })),
  vote: () => vote("approve"),
  reject: () => vote("reject"),
};
for (const button of document.querySelectorAll("[data-run]")) button.onclick = () => runs[button.dataset.run]().catch(error => out({ error: String(error) }));
</script></html>`;
