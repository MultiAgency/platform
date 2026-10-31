// A local testing UI for the platform's app access: it acts as an app deployment, holding that deployment's service
// credential on this machine, and has the owner's wallet sign app texts in a localhost page. Test tooling only: never
// deployed, never given to anyone else. Usage (from the repository root):
//   PLATFORM_URL=https://api.dev.multiagency.ai PLATFORM_APP_CREDENTIAL=tap_… PLATFORM_DEPLOYMENT=staging \
//   ORGANIZATION=org_step8 pnpm exec tsx scripts/staging-app.ts
// then open http://127.0.0.1:4318/. The credential stays in this process; the page never sees it. ORGANIZATION is only
// the page's first Organization: each call names its own.
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
const ORG = /^[A-Za-z0-9_.-]{1,64}$/;
const org = (value: unknown) => { if (typeof value !== "string" || !ORG.test(value)) throw new Error("Name an Organization"); return value; };

/** What the page may ask for. Each answer is the platform's answer, unchanged; texts to sign name this host. */
const ops: Record<string, (input: Record<string, any>) => Promise<unknown>> = {
  config: async () => ({ host, deployment, organization }),
  setupText: async ({ organization, owner, area }) => ({ message: setupMessage({ host, deployment, organization: org(organization), owner, area, expiresAt: later(30 * 60_000) }) }),
  setup: async ({ submission }) => app.setup(submission),
  identity: async ({ agent }) => app.identity(agent),
  consentText: async ({ organization, agent, scopes }) => {
    const identity = await app.identity(agent);
    if (!identity.ok || !identity.value.agentId) return { error: "Not created yet, or identity unreadable", identity };
    return { message: consentMessage({ host, deployment, organization: org(organization), owner: identity.value.owner, agent, agentId: identity.value.agentId,
      scopes, expiresAt: later(30 * 86_400_000) }) };
  },
  consent: async ({ submission }) => app.consents.submit(submission),
  consents: async ({ organization }) => app.consents.list(org(organization)),
  /** A call to one agent's procedure through the app's consent; `expectedPolicy: "current"` is filled from overview. */
  call: async ({ organization, agent, path, input }) => {
    const agentCalls = app.agent(org(organization), agent);
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
    const op = req.method === "POST" && req.url?.startsWith("/api/") && Object.hasOwn(ops, req.url.slice(5)) ? ops[req.url.slice(5)] : undefined;
    if (!op) { res.writeHead(404).end(); return; }
    // Only this page: a cross-site page can't make this process act with the credential.
    if (req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    // Some answers carry bigint balances (owner-outputs.ts): sent, and logged, as decimal strings.
    const answer = JSON.stringify(await op(await read(req)), (_k, v) => typeof v === "bigint" ? v.toString() : v);
    console.log(req.url, answer.slice(0, 400));
    res.writeHead(200, { "content-type": "application/json" }).end(answer);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`App testing UI for ${host} (deployment ${deployment}): http://127.0.0.1:${port}/`));

// The page's script avoids template literals: it lives inside this one.
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>App testing UI</title>
<style>
:root{--b:#d0d7de;--m:#57606a;--bg:#f6f8fa;--ok:#1a7f37;--no:#cf222e;--wait:#9a6700}
*{box-sizing:border-box}body{font:14px/1.45 system-ui,sans-serif;margin:0;color:#1f2328}
header{background:#fff;border-bottom:1px solid var(--b);padding:.6rem 1rem;display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center}
header h1{font-size:1rem;margin:0}main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;padding:1rem}
@media (max-width:900px){main{grid-template-columns:1fr}}
section{border:1px solid var(--b);border-radius:6px;padding:.6rem .8rem;margin-bottom:1rem}h2{font-size:.95rem;margin:.1rem 0 .5rem}
.row{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin:.35rem 0}label{color:var(--m);font-size:.85rem}
input,select{font:inherit;padding:.25rem .4rem;border:1px solid var(--b);border-radius:4px}input.w{width:20rem;max-width:100%}
button{font:inherit;padding:.25rem .6rem;border:1px solid var(--b);border-radius:4px;background:var(--bg);cursor:pointer}button:hover{background:#eaeef2}
.muted{color:var(--m);font-size:.85rem}pre{background:var(--bg);padding:.4rem;margin:.3rem 0;white-space:pre-wrap;word-break:break-all;max-height:22rem;overflow:auto;font-size:.8rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}td,th{border-bottom:1px solid var(--b);padding:.2rem .3rem;text-align:left;vertical-align:top}
.ok{color:var(--ok)}.no{color:var(--no)}.wait{color:var(--wait)}
#log .e{border-top:1px solid var(--b);padding:.3rem 0}#log summary{cursor:pointer}
</style>
<header><h1>App testing UI</h1><span id="config" class="muted"></span>
<button id="connect">Connect wallet</button><span id="account" class="muted"></span>
<label>Organization <input id="org" list="orgs" size="14"></label><datalist id="orgs"></datalist>
<label>Agent <input id="agent" list="agents" size="30" placeholder="own-…"></label><datalist id="agents"></datalist>
<button data-run="loadAgents">Agents with consent</button><button data-run="refresh">Refresh view</button></header>
<main><div>
<section><h2>1. Setup</h2>
<div class="row"><label>Area <select id="area"><option>payables</option><option>treasury</option></select></label>
<button data-run="setup">Sign setup text</button><button data-run="create">Create the agent</button></div>
<div class="row"><label>Scopes</label><label><input type="checkbox" class="scope" value="owner" checked> owner</label>
<label><input type="checkbox" class="scope" value="payout" checked> payout</label><label><input type="checkbox" class="scope" value="read" checked> read</label>
<button data-run="consent">Sign consent</button><button data-run="grant">Issue payout grant</button></div>
<p class="muted">A NEP-413 action is signed here; a NEP-366 one opens the platform's confirm page (its link is also in the history).</p></section>
<section><h2>2. Policy</h2>
<div class="row"><label>Account <input id="payee" class="w" placeholder="payee.near"></label></div>
<div class="row"><button data-run="addTransferPayee">Add transfer payee</button><button data-run="addWithdrawalPayee">Add withdrawal payee</button></div>
<div class="row"><label>wNEAR cap per payout, day and month (yocto) <input id="wnearCap" size="26" placeholder="100000000000000000000000"></label><span id="capHuman" class="muted"></span><button data-run="allowNear">Allow wNEAR</button></div>
<div class="row"><button data-run="approvalOn">Owner approval on</button><button data-run="approvalOff">Owner approval off (auto-pay)</button>
<button data-run="freeze">Freeze</button><button data-run="unfreeze">Unfreeze</button></div>
<div class="row"><label>Correlation ID <input id="correlation" class="w"></label><button data-run="status">Owner status</button></div></section>
<section><h2>3. Payouts</h2>
<div class="row"><label>Asset <select id="asset"><option value="USDC">USDC</option><option value="wNEAR">wNEAR</option></select></label>
<label>Delivery <select id="delivery"><option value="intents">confidential transfer</option><option value="near">withdraw to chain near</option></select></label></div>
<div class="row"><label>Recipient <input id="recipient" class="w" placeholder="defaults to the account above"></label></div>
<div class="row"><label>Amount (base units) <input id="amount" size="26"></label><span id="human" class="muted"></span></div>
<div class="row"><label>Request ID <input id="requestId" size="22"></label><button data-run="newRequest">New ID</button></div>
<div class="row"><button data-run="fund">Deposit address</button><button data-run="pay">Request payout</button><button data-run="payStatus">Payout status</button>
<button data-run="voteApprove">Vote approve</button><button data-run="voteReject">Vote reject</button></div></section>
</div><div>
<section><h2>Agent</h2><div id="view" class="muted">Choose an Organization and agent, then Refresh view.</div></section>
<section><h2>History</h2><div class="row"><button data-run="copyLog">Copy all</button><button data-run="clearLog">Clear</button>
<span class="muted">Newest first; kept for this browser tab.</span></div><div id="log"></div></section>
</div></main>
<script type="module">
import { NearConnector } from "/near-connect.js";
var ASSETS = { USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", wNEAR: "nep141:wrap.near" };
var DECIMALS = { USDC: 6, wNEAR: 24 };
function $(id) { return document.getElementById(id); }
function el(tag, attrs, children) {
  var node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (key) { if (key === "text") node.textContent = attrs[key]; else node.setAttribute(key, attrs[key]); });
  (children || []).forEach(function (child) { if (child) node.append(child); });
  return node;
}
function store(key, value) { try { if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || "null"); sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { return null; } }
var history = store("history") || [];
function renderLog() {
  var log = $("log"); log.replaceChildren();
  history.slice().reverse().forEach(function (entry) {
    var ok = entry.answer && (entry.answer.ok === true || (entry.answer.ok === undefined && !entry.answer.error));
    var head = el("summary", {}, [el("span", { class: ok ? "ok" : "no", text: ok ? "ok " : "no " }), el("span", { text: entry.at.slice(11, 19) + "  " + entry.op + (entry.label ? "  " + entry.label : "") })]);
    var body = [el("pre", { text: "input: " + JSON.stringify(entry.input, null, 2) }), el("pre", { text: "answer: " + JSON.stringify(entry.answer, null, 2) })];
    if (entry.link) body.unshift(el("p", {}, [el("a", { href: entry.link, target: "_blank", rel: "noopener", text: "Open the confirm page" })]));
    log.append(el("details", { class: "e" }, [head].concat(body)));
  });
}
function record(op, label, input, answer, link) {
  history.push({ at: new Date().toISOString(), op: op, label: label, input: input, answer: answer, link: link });
  if (history.length > 200) history = history.slice(-200);
  store("history", history); renderLog(); return answer;
}
async function api(op, input, label) {
  var answer;
  try { answer = await (await fetch("/api/" + op, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input || {}) })).json(); }
  catch (error) { answer = { error: String(error) }; }
  return record(op, label || (input && input.path) || "", input, answer);
}
function context() { var org = $("org").value.trim(), agent = $("agent").value.trim(); if (!org) throw new Error("Name an Organization"); return { org: org, agent: agent }; }
function needAgent() { var c = context(); if (!c.agent) throw new Error("Name an agent"); return c; }
function call(path, input) { var c = needAgent(); return api("call", { organization: c.org, agent: c.agent, path: path, input: input }, path); }
function remember(listId, key, value) {
  if (!value) return; var values = store(key) || []; if (values.indexOf(value) < 0) values.unshift(value); store(key, values.slice(0, 20));
  $(listId).replaceChildren.apply($(listId), values.map(function (v) { return el("option", { value: v }); }));
}

var config = await api("config");
$("config").textContent = config.host + " · deployment " + config.deployment;
$("org").value = store("org") || config.organization; remember("orgs", "orgs", $("org").value); remember("agents", "agents", store("agent"));
$("agent").value = store("agent") || "";
["org", "agent"].forEach(function (id) { $(id).addEventListener("change", function () { store(id, $(id).value.trim()); remember(id === "org" ? "orgs" : "agents", id === "org" ? "orgs" : "agents", $(id).value.trim()); }); });
/** A base-unit amount as a decimal, exactly (no floating point): "1500000" with 6 decimals is "1.5". */
function units(raw, decimals) {
  if (!/^[0-9]+$/.test(raw)) return null;
  var padded = raw.replace(/^0+(?=.)/, "").padStart(decimals + 1, "0"), whole = padded.slice(0, padded.length - decimals), fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return whole + (fraction ? "." + fraction : "");
}
function human() { var a = units($("amount").value.trim(), DECIMALS[$("asset").value]); $("human").textContent = a === null ? "" : "= " + a + " " + $("asset").value; }
function capHuman() { var c = units($("wnearCap").value.trim(), DECIMALS.wNEAR); $("capHuman").textContent = c === null ? "" : "= " + c + " NEAR"; }
$("amount").addEventListener("input", human); $("asset").addEventListener("change", human); $("wnearCap").addEventListener("input", capHuman);
function newRequestId() { $("requestId").value = "r-" + new Date().toISOString().replace(/[-:TZ.]/g, "").slice(2, 14); }
newRequestId(); renderLog();

var connector = new NearConnector({ network: "mainnet", features: { signMessage: true } });
var account, setupKey;
$("connect").onclick = async function () { await connector.connect(); account = (await connector.getConnectedWallet()).accounts[0]; $("account").textContent = account.accountId; };
async function wallet() { return (await connector.getConnectedWallet()).wallet; }
function b64(bytes) { return btoa(String.fromCharCode.apply(null, bytes)); }
function unb64(text) { return Uint8Array.from(atob(text), function (c) { return c.charCodeAt(0); }); }
function needWallet() { if (!account) throw new Error("Connect the owner's wallet first"); return account; }
/** The owner signs an app text (recipient: the platform host) and the platform gets the submission. */
async function signText(message) {
  var nonce = crypto.getRandomValues(new Uint8Array(32));
  var signed = await (await wallet()).signMessage({ message: message, recipient: config.host, nonce: nonce });
  return { message: message, nonce: b64(nonce), publicKey: signed.publicKey, signature: signed.signature };
}
/**
 * Prepares an owner action: a readable intent is signed here and submitted; otherwise the confirm page opens (its link is
 * kept in the history if the browser blocks the tab). check may refuse the prepared answer before the wallet is asked.
 */
async function owner(action, check) {
  var prepared = await call("owner/prepare", { action: action, signer: "wallet" });
  if (!prepared.ok) return;
  var refusal = check && check(prepared.value);
  if (refusal) return record("refused here", action.type, action, { error: refusal, prepared: prepared.value });
  $("correlation").value = prepared.value.correlationId;
  if (prepared.value.confirm) {
    if (String(prepared.value.confirm.url).indexOf("https://" + config.host + "/confirm/") !== 0)
      return record("refused here", action.type, action, { error: "The confirm link isn't on the platform's own confirm page. Not opened.", prepared: prepared.value });
    record("confirm page", action.type, { correlationId: prepared.value.correlationId }, { expiresAt: prepared.value.confirm.expiresAt }, prepared.value.confirm.url);
    window.open(prepared.value.confirm.url, "_blank");
    return;
  }
  var intent = prepared.value.intent;
  var signed = await (await wallet()).signMessage(Object.assign({}, intent.payload, { nonce: unb64(intent.payload.nonce) }));
  await call("owner/submit", { correlationId: prepared.value.correlationId, signedData: Object.assign({}, intent, { public_key: signed.publicKey, signature: signed.signature }) });
}
/**
 * The policy in force and the review it was read under: an edit built from it names that same revision and digest, so
 * the platform refuses it if the policy changed in between (never "current", re-read at prepare time).
 */
async function currentPolicy() {
  var overview = await call("overview");
  if (!overview.ok || !overview.value.policy.policy) throw new Error("The agent's policy couldn't be read");
  return { policy: overview.value.policy.policy, reviewed: { revision: overview.value.policy.revision, digest: overview.value.digest } };
}
function payee() { var p = $("payee").value.trim(); if (!p) throw new Error("Name the account"); return p; }
function recipient() { return $("recipient").value.trim() || $("payee").value.trim(); }
/** How the platform records a recipient: a near.com address ("nearcom:<account>") is its bare account, lowercased. */
function recorded(account) { return /^nearcom:/i.test(account) ? account.slice(8).toLowerCase() : account; }
async function vote(verdict) {
  var held = await call("held");
  var status = await call("payouts/status", { requestId: $("requestId").value });
  var entry = held.ok && status.ok && held.value.find(function (h) { return h.correlationId === status.value.correlationId; });
  if (!entry) return record("vote", verdict, { requestId: $("requestId").value }, { error: "No held payout for this request ID" });
  // The vote's own text names no payee or amount: approving checks the terms the platform proved against this request.
  await owner({ type: "approval_vote", approvalId: entry.approvalId, verdict: verdict, correlationId: entry.correlationId }, function (prepared) {
    if (verdict === "reject") return null;
    var terms = prepared.payment && prepared.payment.terms;
    return terms && terms.recipient === recorded(recipient()) && terms.amount === $("amount").value && terms.asset === ASSETS[$("asset").value] ? null
      : "The proven terms don't match this request's recipient, amount and asset. Not signed.";
  });
}

function cell(text, cls) { return el("td", cls ? { class: cls, text: text } : { text: text }); }
function table(headers, rows) { return el("table", {}, [el("tr", {}, headers.map(function (h) { return el("th", { text: h }); }))].concat(rows.map(function (r) { return el("tr", {}, r); }))); }
function assetName(a) { return a === ASSETS.USDC ? "USDC" : a === ASSETS.wNEAR ? "wNEAR" : a; }
async function refresh() {
  var view = $("view"); view.replaceChildren(el("p", { text: "Reading…" }));
  var c = needAgent(), parts = [];
  var identity = await api("identity", { agent: c.agent }, "identity");
  if (identity.ok) parts.push(el("p", { text: "Owner " + identity.value.owner + " · " + (identity.value.created ? "created" : "not created yet") + (identity.value.agentId ? " · " + identity.value.agentId.slice(0, 12) + "…" : "") }));
  var overview = await call("overview");
  if (overview.ok) {
    var v = overview.value, p = v.policy.policy || {};
    var budget = (v.policy.usage && v.policy.usage.budget) || {};
    parts.push(el("h2", { text: "Policy (revision " + v.policy.revision + ")" }));
    parts.push(table(["", ""], [
      [cell("Actions"), cell((p.actions || []).join(", "))],
      [cell("Owner approval"), cell(p.owner_approval ? "on: every payout waits for a vote" : "off: paid within the policy", p.owner_approval ? "" : "wait")],
      [cell("Frozen"), cell(p.frozen ? "yes" : "no", p.frozen ? "no" : "")],
      [cell("Assets"), cell((p.assets || []).map(assetName).join(", "))],
      [cell("Payees"), cell(((p.destinations && p.destinations.list) || []).map(function (d) { return d.action + " " + d.address + (d.chain ? " (" + d.chain + ")" : ""); }).join("; ") || "none")],
      [cell("Budget left"), cell(["daily", "weekly", "monthly"].map(function (w) { var b = budget[w]; return b && b.limit_usd ? w + " $" + b.remaining_usd + " of $" + b.limit_usd : null; }).filter(Boolean).join(" · ") || "uncapped")],
    ]));
    parts.push(el("h2", { text: "Balances" }));
    parts.push(table(["Asset", "Confidential", "Public"], (v.book || []).map(function (b) {
      var d = Math.pow(10, b.decimals); return [cell(b.symbol), cell(String(Number(b.confidential) / d)), cell(String(Number(b.public) / d))];
    })));
  }
  var held = await call("held");
  if (held.ok) {
    parts.push(el("h2", { text: "Held for the owner (" + held.value.length + ")" }));
    if (held.value.length) parts.push(table(["Asset", "Amount", "Recipient", "Correlation"], held.value.map(function (h) {
      return [cell(assetName(h.request.asset)), cell(h.request.amount), cell(h.request.recipient), cell(h.correlationId)];
    })));
  }
  var actions = await call("owner/actions");
  if (actions.ok) {
    parts.push(el("h2", { text: "Recent owner actions" }));
    parts.push(table(["Type", "Status", "Correlation"], actions.value.slice(0, 8).map(function (a) {
      return [cell(a.type), cell(a.status || a.stage, a.status === "SUCCESS" ? "ok" : a.status === "FAILED" ? "no" : "wait"), cell(a.correlationId)];
    })));
  }
  view.replaceChildren.apply(view, parts.length ? parts : [el("p", { class: "no", text: "Nothing readable: check the agent, the Organization and the consent (see History)." })]);
}

var runs = {
  loadAgents: async function () {
    var c = context(), listed = await api("consents", { organization: c.org });
    if (listed.ok) listed.value.consents.filter(function (consent) { return !consent.revoked; }).forEach(function (consent) { remember("agents", "agents", consent.agent); });
  },
  refresh: refresh,
  setup: async function () {
    var c = context(), a = needWallet();
    var text = await api("setupText", { organization: c.org, owner: a.accountId, area: $("area").value });
    var submission = await signText(text.message);
    var r = await api("setup", { submission: submission });
    if (r.ok) { $("agent").value = r.value.agent; store("agent", r.value.agent); remember("agents", "agents", r.value.agent); setupKey = submission.publicKey; store("setupKey", setupKey); }
  },
  create: function () { var a = needWallet(); return owner({ type: "agent_create", owner: { type: "near", account_id: a.accountId, public_key: setupKey || store("setupKey") || a.publicKey }, role: $("area").value === "payables" ? "payout" : "treasury" }); },
  consent: async function () {
    var c = needAgent(); needWallet();
    var scopes = Array.prototype.filter.call(document.querySelectorAll(".scope"), function (s) { return s.checked; }).map(function (s) { return s.value; });
    var text = await api("consentText", { organization: c.org, agent: c.agent, scopes: scopes });
    if (text.message) await api("consent", { submission: await signText(text.message) });
  },
  grant: function () { return owner({ type: "grant_issue", label: "payout" }); },
  // The edit names the whole list: each adds to the payees in force, never replacing them.
  addTransferPayee: async function () {
    var read = await currentPolicy(), p = read.policy, list = (p.destinations.list || []).filter(function (d) { return d.action === "transfer"; }).map(function (d) { return { address: d.address, confidential: d.confidential !== false }; });
    if (!list.some(function (d) { return d.address === payee(); })) list.push({ address: payee(), confidential: true });
    return owner({ type: "policy_update", expectedPolicy: read.reviewed, changes: { destinations: list } });
  },
  addWithdrawalPayee: async function () {
    var read = await currentPolicy(), p = read.policy, list = (p.destinations.list || []).filter(function (d) { return d.action === "withdraw" && d.chain === "near" && d.memo === null; }).map(function (d) { return { address: d.address }; });
    if (!list.some(function (d) { return d.address === payee(); })) list.push({ address: payee() });
    return owner({ type: "policy_update", expectedPolicy: read.reviewed, changes: { withdrawals: list } });
  },
  // Adds wNEAR to the assets and caps it per payout, day and month, keeping every other cap (an edit replaces limits whole).
  allowNear: async function () {
    var cap = $("wnearCap").value.trim();
    if (!/^[1-9][0-9]*$/.test(cap)) throw new Error("Give a wNEAR cap in yoctoNEAR");
    var read = await currentPolicy(), p = read.policy;
    if (!Array.isArray(p.assets)) throw new Error("This policy allows any asset; nothing to add");
    var limits = Object.assign({}, p.limits);
    ["per_transaction", "daily", "monthly"].forEach(function (w) { limits[w] = Object.assign({}, limits[w]); limits[w][ASSETS.wNEAR] = cap; });
    return owner({ type: "policy_update", expectedPolicy: read.reviewed, changes: { assets: p.assets.concat(p.assets.indexOf(ASSETS.wNEAR) < 0 ? [ASSETS.wNEAR] : []), limits: limits } });
  },
  approvalOn: function () { return owner({ type: "policy_update", expectedPolicy: "current", changes: { owner_approval: true } }); },
  approvalOff: function () { return owner({ type: "policy_update", expectedPolicy: "current", changes: { owner_approval: false } }); },
  freeze: function () { return owner({ type: "agent_freeze" }); },
  unfreeze: function () { return owner({ type: "agent_unfreeze" }); },
  status: function () { return call("owner/status", { correlationId: $("correlation").value }); },
  newRequest: newRequestId,
  fund: function () { return call("deposit", { asset: ASSETS[$("asset").value] }); },
  pay: function () {
    return call("payouts/request", { requestId: $("requestId").value, asset: ASSETS[$("asset").value],
      delivery: $("delivery").value === "near" ? { chain: "near" } : "intents", recipient: recipient(), amount: $("amount").value, expectedPolicy: "current" });
  },
  payStatus: function () { return call("payouts/status", { requestId: $("requestId").value }); },
  voteApprove: function () { return vote("approve"); },
  voteReject: function () { return vote("reject"); },
  copyLog: async function () { await navigator.clipboard.writeText(JSON.stringify(history, null, 2)); },
  clearLog: function () { history = []; store("history", history); renderLog(); },
};
document.querySelectorAll("[data-run]").forEach(function (button) {
  button.onclick = async function () {
    button.disabled = true;
    try { await runs[button.dataset.run](); } catch (error) { record(button.dataset.run, "", {}, { error: String(error && error.message || error) }); }
    finally { button.disabled = false; }
  };
});
</script></html>`;
