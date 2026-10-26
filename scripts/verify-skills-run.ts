// Runs the SDK skills' examples (copied into an isolated consumer by verify-skills.mjs) against stand-in servers:
// an oRPC owner agent and a payee entry. Each check records what was sent and asserts the documented recovery.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { ownerClient } from "@multiagency/sdk";
import { payeeClient } from "@multiagency/sdk/payee";
import { owner as setupOwner } from "./examples/owner-workflows-1.ts";
import { heldPayouts } from "./examples/owner-workflows-2.ts";
import { freezeAgent } from "./examples/owner-workflows-3.ts";
import { execute } from "./examples/owner-workflows-4.ts";
import { machineClient } from "./examples/owner-workflows-5.ts";
import { payee as setupPayee } from "./examples/payee-workflows-1.ts";
import { agentFor } from "./examples/payee-workflows-2.ts";
import { newReport, readRequest, revision, send } from "./examples/payee-workflows-3.ts";
import { connectAgent, revokeAll } from "./examples/payee-workflows-4.ts";

const listen = async (handle: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handle);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(done => server.close(() => done())) };
};
const ran: Record<string, unknown> = {};
ok(setupOwner && setupPayee, "setup examples construct their clients");

// Owner agent stand-in, mounted where the gateway mounts it.
const calls: string[] = [];
let dropHeld = 1;
const nep413 = { standard: "nep413" as const, payload: { message: "freeze", recipient: "intents.near", nonce: "AAAA" } };
const router = {
  held: os.handler(() => { if (dropHeld-- > 0) throw new Error("connection reset"); return []; }),
  owner: {
    prepare: os.handler(() => ({ correlationId: "c-1", preview: { summary: "Freeze the agent" }, expiresAt: new Date(Date.now() + 600_000).toISOString(), digest: null, intent: nep413 })),
    submit: os.handler(({ input }) => { deepStrictEqual(input, { correlationId: "c-1", signedData: { ...nep413, public_key: "ed25519:k", signature: "s" } }); throw new Error("reply lost"); }),
    status: os.handler(() => ({ stage: "submitted", status: "SUCCESS" })),
  },
  executePlan: os.handler(async function* () {
    yield { type: "action", index: 0, action: { type: "shield", asset: "usdc", amount: "1" }, status: "SUCCESS", correlationId: "e-1" };
    throw new Error("stream lost");
  }),
};
const handler = new RPCHandler(router);
const agent = await listen(async (req, res) => {
  calls.push(req.url!.replace("/a/payout/rpc/", ""));
  const { matched } = await handler.handle(req, res, { prefix: "/a/payout/rpc" });
  if (!matched) res.writeHead(404).end();
});
const owner = ownerClient({ base: "/a/payout", fetch: (url, init) => fetch(new URL((url as URL).pathname, agent.base), init) });

deepStrictEqual(await heldPayouts(owner), { ok: true, value: [] });
deepStrictEqual(calls.splice(0), ["held", "held"], "a lost read is read again once");
ran.heldPayouts = "lost read, read again once";

let signatures = 0;
const frozen = await freezeAgent(owner, async intent => { signatures++; return { ...intent, public_key: "ed25519:k", signature: "s" }; });
deepStrictEqual(frozen, { ok: true, value: { stage: "submitted", status: "SUCCESS" } });
deepStrictEqual(calls.splice(0), ["owner/prepare", "owner/submit", "owner/status"], "a lost submit is read by its correlation id, never resent");
equal(signatures, 1);
ran.freezeAgent = "signed once, submitted once, outcome read by correlationId";

const planId = randomUUID();
const executed = await execute(owner, planId);
equal(executed.events.length, 1);
deepStrictEqual(executed.failure, { ok: false, kind: "unknown", procedure: "executePlan", identity: { planId } });
deepStrictEqual(calls.splice(0), ["executePlan"], "a stream lost after an event is never executed again");
ran.execute = "event kept, lost stream unknown with planId";

// The machine example: an absolute base on the scoped route, the bearer added by its fetch, no cookie, redirects refused.
const browserFetch = globalThis.fetch;
const machineSent: { url: string; authorization: string | null; cookie: string | null; redirect: string | undefined }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input)), headers = new Headers(init?.headers);
  machineSent.push({ url: url.href, authorization: headers.get("authorization"), cookie: headers.get("cookie"), redirect: init?.redirect });
  return browserFetch(new URL(url.pathname.replace("/machine/v1/a/treasury/rpc/", "/a/payout/rpc/"), agent.base), init);
}) as typeof fetch;
try {
  deepStrictEqual(await machineClient("https://treasury.example", "treasury", "tmc_fixture").call("held"), { ok: true, value: [] });
} finally { globalThis.fetch = browserFetch; }
deepStrictEqual(machineSent, [{ url: "https://treasury.example/machine/v1/a/treasury/rpc/held", authorization: "Bearer tmc_fixture", cookie: null, redirect: "error" }]);
equal(calls.splice(0).length, 1, "one request, no retry");
ok((() => { try { machineClient("http://treasury.example", "treasury", "t"); return false; } catch { return true; } })(), "plain HTTP origins are refused");
ran.machineClient = "absolute machine base, bearer from its fetch, no cookie, no redirects";
await agent.close();

// Payee entry stand-in: the payee's records, and agent connections managed from the browser session.
const sent: { method: string; path: string; authorization: string | null }[] = [];
// The entry's rules for reports (src/compensation-store.ts): a command id answers its first result again for the same
// content and is refused for other content; versions must match; only a draft or returned request can be revised.
const requests: Record<string, any>[] = [], commands = new Map<string, { input: string; output: unknown }>(), payments: { requestId: string; id: string; status: string }[] = [];
const agreement = { id: randomUUID(), version: 1, recordedBy: "owner", at: new Date().toISOString(), approved: "0", remaining: "50000000",
  terms: { payee: "c.near", title: "October", document: "https://example.com/terms", signedOn: "2026-09-30", start: "2026-10-01", end: "2026-10-31", ceiling: "50000000", openingApproved: "0", scope: "Community work" } };
const connections = [{ id: randomUUID(), label: "Old agent", role: "payee", permissions: ["compensation.read", "compensation.submit"], host: "invoices.test",
  instance: "i-1", account: "c.near", agentId: "a-1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revoked: false }];
const body = (req: IncomingMessage) => new Promise<any>(done => { let text = ""; req.on("data", (chunk: Buffer) => text += chunk).on("end", () => done(text ? JSON.parse(text) : undefined)); });
const entry = await listen(async (req, res) => {
  const path = req.url!, json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  sent.push({ method: req.method!, path, authorization: req.headers.authorization ?? null });
  if (req.method === "GET" && path === "/api/compensation/session") return json(200, { account: "c.near" });
  if (req.method === "GET" && path === "/api/compensation") return json(200, { account: "c.near", agreements: [agreement], requests, history: [], payments });
  if (req.method === "POST" && path === "/api/compensation") {
    const command = await body(req), input = JSON.stringify(command), prior = commands.get(command.commandId);
    if (prior) return prior.input === input ? json(200, prior.output) : json(409, { code: "command_conflict", error: "This command identity has different content." });
    const old = requests.find(r => r.id === command.id);
    if ((old?.version ?? 0) !== command.expectedVersion) return json(409, { code: "stale_request", error: "The request changed." });
    if (old && !["draft", "changes_requested"].includes(old.state)) return json(409, { code: "request_locked", error: "Only a draft or returned request can be revised." });
    const next = { id: command.id, version: command.expectedVersion + 1, payee: "c.near", agreementVersion: 1, report: command.report,
      state: command.submit ? "submitted" : "draft", feedback: "", reviewedBy: null, at: new Date().toISOString(), payment: null };
    if (old) Object.assign(old, next); else requests.push(next);
    commands.set(command.commandId, { input, output: next });
    return json(200, next);
  }
  if (req.method === "GET" && path === "/api/agent-connections") return json(200, { connections });
  if (req.method === "POST" && path === "/api/agent-connections") {
    const issued = { ...connections[0], id: randomUUID(), label: (await body(req)).label };
    connections.push(issued);
    return json(201, { connection: issued, token: `tac_${randomUUID()}.${"A".repeat(43)}` });
  }
  if (req.method === "DELETE" && path.startsWith("/api/agent-connections/")) {
    connections.find(c => c.id === path.split("/").at(-1))!.revoked = true;
    return json(200, { revoked: true });
  }
  json(404, { error: "Not found" });
});

const token = `tac_${randomUUID()}.${"A".repeat(43)}`;
const viaAgent = agentFor(entry.base, token);
deepStrictEqual(await viaAgent.compensationSession(), { ok: true, value: { account: "c.near" } });
equal(sent.at(-1)!.authorization, `Bearer ${token}`);
ran.agentFor = "bearer token sent";

const posts = () => sent.filter(s => s.method === "POST" && s.path === "/api/compensation").length;
const kept: string[] = [];
const retain = async (command: { commandId: string }) => { kept.push(command.commandId); };
const fields = { start: "2026-10-01", end: "2026-10-15", contributions: "Hosted the meetup", assessment: "Delivered the agreed scope", evidence: ["https://example.com/meetup"] };
// Outside the agreement or invalid: refused locally, nothing sent.
deepStrictEqual((await newReport(viaAgent, agreement.id, { ...fields, end: "2026-11-02" }, false)).ok, false);
deepStrictEqual((await newReport(viaAgent, randomUUID(), fields, false)).ok, false);
deepStrictEqual((await newReport(viaAgent, agreement.id, { ...fields, contributions: "" }, false)).ok, false);
equal(posts(), 0, "invalid reports are never sent");
// Save a draft (no amount), then submit a revision with a proposed amount: same request id, new command id, version 1 → 2.
const draft = await newReport(viaAgent, agreement.id, fields, false);
ok(draft.ok && draft.value.expectedVersion === 0 && draft.value.report.amount === undefined);
const saved = await send(viaAgent, draft.value, retain);
ok(saved.sent.ok && saved.sent.value.state === "draft" && saved.sent.value.version === 1);
const submitted = revision(saved.sent.value, { ...fields, amount: "12000000" }, true);
ok(submitted.ok && submitted.value.id === draft.value.id && submitted.value.commandId !== draft.value.commandId && submitted.value.expectedVersion === 1);
const review = await send(viaAgent, submitted.value, retain);
ok(review.sent.ok && review.sent.value.state === "submitted" && review.sent.value.version === 2 && review.sent.value.report.amount === "12000000");
deepStrictEqual(revision(review.sent.value, fields, true).ok, false, "a submitted request is not revised");
// The same command id with other content is refused; nothing changes.
const conflict = await viaAgent.submitReport({ ...submitted.value, report: { ...submitted.value.report, amount: "99000000" } });
ok(!conflict.ok && conflict.kind === "refused" && conflict.code === "command_conflict");
// Retention fails: nothing is sent.
const before = posts(), fresh = await newReport(viaAgent, agreement.id, fields, true);
ok(fresh.ok);
await send(viaAgent, fresh.value, async () => { throw new Error("storage full"); }).then(() => { throw new Error("send continued"); }, () => undefined);
equal(posts(), before, "an unretained command is never sent");
// The POST reaches the entry and its reply is lost: unknown, followed by one read, never another POST.
const losing = payeeClient({ base: entry.base, token, fetch: async (input, init) => {
  const response = await fetch(input, init);
  if (init?.method === "POST") throw new TypeError("reply lost");
  return response;
} });
const lostReport = await newReport(losing, agreement.id, fields, true);
ok(lostReport.ok);
const lost = await send(losing, lostReport.value, retain);
ok(!lost.sent.ok && lost.sent.kind === "unknown" && lost.applied, "a lost new report that was recorded reads as applied");
ok(lost.observed?.ok && lost.observed.value.request?.id === lostReport.value.id, "the lost reply is followed by a read of the kept id");
equal(kept.at(-1), lostReport.value.commandId, "retained before sending");
equal(posts(), before + 1, "one submission; recovery is a read");
// A lost revision the entry never applied: the request exists at the old version, so it is not applied and stays unknown.
const returned = requests.find(r => r.id === lostReport.value.id)!;
Object.assign(returned, { state: "changes_requested", feedback: "Add the agenda link" });
const rework = revision(returned as never, { ...fields, evidence: ["https://example.com/agenda"] }, true);
ok(rework.ok);
const dropping = payeeClient({ base: entry.base, token, fetch: async (input, init) => {
  if (init?.method === "POST") throw new TypeError("connection reset before the entry read it");
  return fetch(input, init);
} });
const lostRevision = await send(dropping, rework.value, retain);
ok(!lostRevision.sent.ok && lostRevision.sent.kind === "unknown" && !lostRevision.applied, "a revision never applied is not read as applied");
ok(lostRevision.observed?.ok && lostRevision.observed.value.request?.version === returned.version, "the request is still at its old version");
// The person sends the identical command again: applied once, and a further identical send answers the same record.
const again = await viaAgent.submitReport(rework.value), once = await viaAgent.submitReport(rework.value);
ok(again.ok && again.value.version === returned.version && again.value.state === "submitted");
deepStrictEqual(once, again, "an identical command answers its recorded result");
ran.report = "draft → revision → submitted, refusals local, retained before send, lost new report applied, lost revision not applied, identical resend applied once";
// Approved is not paid: only a payment recorded as paid is settlement.
Object.assign(requests.find(r => r.id === draft.value.id)!, { state: "approved", approvedAmount: "10000000" });
payments.push({ requestId: draft.value.id, id: randomUUID(), status: "paying" });
const approved = await readRequest(viaAgent, draft.value.id);
ok(approved.ok && approved.value.state === "approved" && approved.value.proposed === "12000000" && approved.value.approved === "10000000" && !approved.value.paid);
payments[0]!.status = "paid";
const paid = await readRequest(viaAgent, draft.value.id);
ok(paid.ok && paid.value.paid);
ran.readRequest = "proposed and approved amounts separate; paid only when recorded paid";

const browser = payeeClient({ base: entry.base });
const connected = await connectAgent(browser);
ok(connected.ok && connected.value.token.startsWith("tac_"));
deepStrictEqual(connected.ok && connected.value.permissions, ["compensation.read", "compensation.submit"]);
deepStrictEqual(await revokeAll(browser), { ok: true, value: 2 });
ok(connections.every(c => c.revoked));
ok(sent.filter(s => s.path.startsWith("/api/agent-connections")).every(s => s.authorization === null), "connections are managed without a token");
ran.connections = "started, listed and revoked from the browser session";
await entry.close();

console.log(JSON.stringify(ran));
