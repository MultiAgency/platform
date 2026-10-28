import assert from "node:assert/strict";
import { test } from "node:test";
import type { InferRouterInputs, InferRouterOutputs } from "@orpc/server";
import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { z } from "zod";
import type { Router } from "../src/router.js";
import { os } from "../src/rpc/base.js";
import { MoneyLockBusy, UnresolvedOperations } from "../src/lock.js";
import { PublicError } from "../src/public-error.js";
import { ownerClient, type OwnerProcedure } from "../src/contract/owner-client.js";
import type { OwnerInputs } from "../src/contract/owner-inputs.js";
import type { ownerOutputs } from "../src/contract/owner-outputs.js";

// Compile time: the published contract equals what the router accepts and accepts everything it returns.
type At<T, P extends string> = P extends `${infer H}/${infer R}` ? H extends keyof T ? At<T[H], R> : never : P extends keyof T ? T[P] : never;
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
// A procedure without input infers as `void`; the client spells it `undefined`.
type Input<P extends OwnerProcedure> = [At<InferRouterInputs<Router>, P>] extends [void] ? undefined : At<InferRouterInputs<Router>, P>;
type Event<T> = T extends AsyncIterable<infer E> ? E : T;
type Output<P extends OwnerProcedure> = Event<Awaited<At<InferRouterOutputs<Router>, P>>>;
type InputMismatch = { [P in OwnerProcedure]: Same<OwnerInputs[P], Input<P>> extends true ? never : P }[OwnerProcedure];
type OutputRejected = { [P in OwnerProcedure]: Output<P> extends z.input<(typeof ownerOutputs)[P]> ? never : P }[OwnerProcedure];
const inputsMatch: [InputMismatch] extends [never] ? true : InputMismatch = true;
const outputsAccepted: [OutputRejected] extends [never] ? true : OutputRejected = true;
// The policy schedule is the SDK's own shape, both ways: what the provider sends is accepted, and what a consumer
// reads can be handed to SDK-typed code.
type Schedule = NonNullable<NonNullable<z.output<(typeof ownerOutputs)["overview"]>["policy"]>["policy"]>["schedule"];
const scheduleIsSdk: [NonNullable<Schedule>] extends [import("@near-intents-agent-api/sdk").Schedule] ? [import("@near-intents-agent-api/sdk").Schedule] extends [NonNullable<Schedule>] ? true : false : false = true;
void [inputsMatch, outputsAccepted, scheduleIsSdk];

/** The real wire: an oRPC handler with Proto's error middleware, behind the client's fetch. */
function serve(routes: Record<string, unknown>, gateway?: (request: Request) => Response | undefined) {
  const handler = new RPCHandler(routes as never);
  const requests: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(new URL(request.url).pathname);
    const denied = gateway?.(request); if (denied) return denied;
    // Like fetch: an abort rejects the request even while the handler is still working.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (init?.signal?.aborted) fail(); else init?.signal?.addEventListener("abort", fail, { once: true });
    });
    const { response } = await Promise.race([handler.handle(request, { prefix: "/a/payout/rpc" }), aborted]);
    return response ?? new Response("", { status: 404 });
  };
  return { client: ownerClient({ base: "/a/payout", fetch }), requests };
}
const throwing = (error: unknown) => os.handler(() => { throw error; });

test("a malformed read is unavailable; a malformed mutation answer keeps its identity as unknown and is not resent", async () => {
  const { client, requests } = serve({ instance: os.handler(() => ({ agentId: 7 })), cancelPreparedInvoice: os.input(undefined as never).handler(() => ({ unexpected: true })) });
  assert.deepEqual(await client.call("instance"), { ok: false, kind: "unavailable" });
  const identity = { id: "a".repeat(32) };
  assert.deepEqual(await client.call("cancelPreparedInvoice", identity), { ok: false, kind: "unknown", procedure: "cancelPreparedInvoice", identity });
  assert.equal(requests.filter(p => p.endsWith("/cancelPreparedInvoice")).length, 1);
});

test("recovery cases are distinguishable by kind, without parsing messages", async () => {
  const { client } = serve({ pay: throwing(new UnresolvedOperations([])), deposit: throwing(new MoneyLockBusy()), recover: throwing(new PublicError("Reviewed.")),
    autopilot: { tick: throwing(new Error("disk full at /private/path")) }, setup: throwing(new Error("provider down")) });
  const pay = { recipient: "a.near", asset: "nep141:usdc", amount: "1", confidential: true, expectedPolicy: { revision: 1, digest: "sha256:" + "0".repeat(64) } };
  assert.equal((await client.call("pay", pay) as { kind: string }).kind, "unresolved");
  assert.equal((await client.call("deposit") as { kind: string }).kind, "busy");
  assert.equal((await client.call("recover") as { kind: string }).kind, "refused");
  assert.deepEqual(await client.call("autopilot/tick"), { ok: false, kind: "unknown", procedure: "autopilot/tick", identity: {} }, "a server failure after a tick may have moved funds");
  assert.deepEqual(await client.call("setup"), { ok: false, kind: "unavailable" });
});

test("gateway denials are session or forbidden by status, even as plain JSON or HTML", async () => {
  let status = 401;
  const { client } = serve({}, () => new Response(status === 401 ? '{"error":"Sign in first","access":"session"}' : "<html>no</html>", { status }));
  assert.deepEqual(await client.call("overview"), { ok: false, kind: "session", status: 401, error: "Sign in first", scope: "session", source: "gateway" });
  status = 403;
  assert.deepEqual(await client.call("deposit"), { ok: false, kind: "forbidden", status: 403, error: "This account may not do that.", source: "gateway" });
});

test("a gateway denial carries the scope it declares, and none when it declares none", async () => {
  let body: unknown;
  const { client } = serve({ overview: os.handler(() => { throw new ORPCError("FORBIDDEN", { message: "Agent server refusal" }); }) },
    request => body === undefined ? undefined : Response.json(body, { status: 403 }));
  for (const scope of ["agent", "procedure"] as const) {
    body = { error: "Denied", access: scope };
    assert.deepEqual(await client.call("activity"), { ok: false, kind: "forbidden", status: 403, error: "Denied", scope, source: "gateway" });
  }
  // A machine route or older gateway declares no scope, and an unknown value is not guessed at.
  for (const answer of [{ error: "Credential does not authorize this agent" }, { error: "Denied", access: "everything" }]) {
    body = answer;
    assert.deepEqual(await client.call("activity"), { ok: false, kind: "forbidden", status: 403, error: answer.error, source: "gateway" });
  }
  // An agent server's own encoded refusal is not a gateway denial.
  body = undefined;
  assert.deepEqual(await client.call("overview"), { ok: false, kind: "forbidden", status: 403, error: "Agent server refusal", source: "agent" });
});

test("a transport failure after a mutation is unknown with its identity; after a read it is unavailable", async () => {
  const client = ownerClient({ base: "/a/payout", fetch: async () => { throw new TypeError("network"); } });
  assert.deepEqual(await client.call("workOrders/file", { id: "w" }), { ok: false, kind: "unknown", procedure: "workOrders/file", identity: { id: "w" } });
  assert.deepEqual(await client.call("held"), { ok: false, kind: "unavailable" });
});

test("streams: invalid events and failures after the first event are unknown with the input identity", async () => {
  // Each fault follows a valid event, which the client must have delivered first: the fault, not the event, decides.
  const rejected = { type: "rejected", problems: [] }, plan = { type: "plan", exposed: [] };
  const { client } = serve({
    executePlan: os.handler(async function* () { yield rejected; throw new UnresolvedOperations([]); }),
    sweep: os.handler(async function* () { yield plan; yield { type: "shield", malformed: true }; }),
    rebalance: throwing(new MoneyLockBusy()),
  });
  const drain = async (events: AsyncGenerator<unknown, unknown>) => { const seen = []; for (;;) { const next = await events.next(); if (next.done) return { seen, result: next.value }; seen.push(next.value); } };
  const executed = await drain(client.stream("executePlan", { planId: "p-1" }));
  assert.deepEqual(executed.seen, [rejected], "the valid event was consumed before the failure");
  assert.deepEqual(executed.result, { ok: false, kind: "unknown", procedure: "executePlan", identity: { planId: "p-1" } });
  const swept = await drain(client.stream("sweep", { execute: true }));
  assert.deepEqual(swept.seen, [plan], "the valid event was consumed before the invalid one");
  assert.deepEqual(swept.result, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal(((await drain(client.stream("rebalance", undefined))).result as { kind: string }).kind, "busy", "a refusal before any event keeps its kind");
});

test("a provider failure carries its refusal details", async () => {
  const { AgentApiError } = await import("@near-intents-agent-api/sdk");
  const refusal = new AgentApiError(403, { errors: [{ status: "403", code: "spend_budget_exceeded", title: "Budget", meta: { budget_remaining_usd: "1.5", available_at: "2030-01-01T00:00:00Z" } }] } as never);
  const { client } = serve({ deposit: throwing(refusal) });
  const result = await client.call("deposit") as { kind: string; code?: string; details?: unknown };
  assert.equal(result.kind, "provider"); assert.equal(result.code, "spend_budget_exceeded");
  assert.deepEqual(result.details, { availableAt: "2030-01-01T00:00:00Z", budgetRemainingUsd: "1.5" });
});

test("an aborted read is unavailable; an aborted mutation or stream is unknown with its identity", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const { client } = serve({
    held: os.handler(async () => { await hold; return []; }),
    workOrders: { file: os.handler(async () => { await hold; return { id: "x", status: "waiting" }; }) },
    sweep: os.handler(async function* () { yield { type: "plan", exposed: [] }; await hold; }),
  });
  const abort = () => { const controller = new AbortController(); setTimeout(() => controller.abort(), 20); return controller.signal; };
  assert.deepEqual(await client.call("held", undefined, { signal: abort() }), { ok: false, kind: "unavailable" });
  assert.deepEqual(await client.call("workOrders/file", { id: "w" }, { signal: abort() }), { ok: false, kind: "unknown", procedure: "workOrders/file", identity: { id: "w" } });
  const events = client.stream("sweep", { execute: true }, { signal: abort() });
  const seen = []; let next = await events.next(); while (!next.done) { seen.push(next.value); next = await events.next(); }
  assert.deepEqual(seen, [{ type: "plan", exposed: [] }], "the valid event was consumed before the abort");
  assert.deepEqual(next.value, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  release();
});


test("non-oRPC answers (proxy HTML, foreign JSON, error responses, cut streams) are lost, never refused, and never retried", async () => {
  // None is an encoded oRPC error, so none is an ORPCError (the client keeps only a plain answer's status): after a
  // mutation the outcome is unknown.
  const answers: Record<string, [() => Response, number | undefined]> = {
    html: [() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }), 502],
    foreign: [() => Response.json({ error: "upstream" }, { status: 500 }), 500],
    errored: [() => Response.error(), undefined],
    redirected: [() => new Response(null, { status: 302, headers: { location: "/elsewhere" } }), 302],
  };
  for (const [name, [answer, httpStatus]] of Object.entries(answers)) {
    let requests = 0;
    const client = ownerClient({ base: "/a/payout", fetch: async () => { requests++; return answer(); } });
    const seen = httpStatus === undefined ? {} : { httpStatus };
    assert.deepEqual(await client.call("workOrders/file", { id: "w" }), { ok: false, kind: "unknown", procedure: "workOrders/file", identity: { id: "w" }, ...seen }, name);
    assert.deepEqual(await client.call("held"), { ok: false, kind: "unavailable", ...seen }, name);
    assert.equal(requests, 2, `${name}: one request per call, no retry`);
  }
  // A stream cut after a valid event, without its closing event: unknown, one request, no reconnect.
  let requests = 0;
  const cut = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ json: { type: "plan", exposed: [] } })}\n\n`));
    setTimeout(() => controller.error(new TypeError("connection reset")), 20);
  } }), { headers: { "content-type": "text/event-stream" } });
  const events = ownerClient({ base: "/a/payout", fetch: async () => { requests++; return cut(); } }).stream("sweep", { execute: true });
  const seen = []; let next = await events.next(); while (!next.done) { seen.push(next.value); next = await events.next(); }
  assert.deepEqual(seen, [{ type: "plan", exposed: [] }]);
  assert.deepEqual(next.value, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal(requests, 1, "a cut stream is not retried");
});

test("a provider failure that does not prove non-execution leaves a mutation unknown with its identity; a read stays provider", async () => {
  const { AgentApiError } = await import("@near-intents-agent-api/sdk");
  // A 503 (or proxy HTML wrapped by the SDK) after a submission was attempted: the operation may exist.
  const unproven = () => new AgentApiError(503, { errors: [{ status: "503", code: "service_unavailable", title: "Unavailable" }] } as never);
  const { client } = serve({ deposit: throwing(unproven()), held: throwing(unproven()), sweep: os.handler(async function* () { throw unproven(); }) });
  assert.deepEqual(await client.call("deposit"), { ok: false, kind: "unknown", procedure: "deposit", identity: {} });
  const events = client.stream("sweep", { execute: true });
  let next = await events.next(); while (!next.done) next = await events.next();
  assert.deepEqual(next.value, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal((await client.call("held") as { kind: string }).kind, "provider", "a read has no effect to hide");
});

// Compile time: Recovery B's diagnostic evidence is declared, so a typed consumer reads its fields without a cast.
type UnresolvedEvidence = NonNullable<z.output<(typeof ownerOutputs)["unresolved"]>[number]["evidence"]>;
const evidenceTyped: [UnresolvedEvidence["requestId"], UnresolvedEvidence["httpStatus"], UnresolvedEvidence["providerIds"]] extends [string | null, number, Record<string, string>] ? true : false = true;
void evidenceTyped;

test("unresolved evidence is optional and diagnostic: older answers parse, malformed evidence never hides the operation", async () => {
  const op = { key: "rebalance:4b39", at: "2026-10-19T00:00:00Z", kind: "rebalance", request: {}, status: null, sent: false };
  const evidence = { at: "2026-10-19T00:00:01Z", httpStatus: 400, code: "policy_usage_unavailable", requestId: "req_1", providerIds: {}, message: "x", note: "Diagnostic only" };
  const read = async (rows: unknown[]) => {
    const { client } = serve({ unresolved: os.handler(() => rows) });
    const answer = await client.call("unresolved");
    assert.equal(answer.ok, true, JSON.stringify(answer));
    return (answer as { value: Record<string, unknown>[] }).value;
  };
  // An answer from a server before Recovery B: no evidence key at all.
  assert.deepEqual(await read([op]), [op]);
  assert.deepEqual(await read([{ ...op, evidence: null }]), [{ ...op, evidence: null }]);
  assert.deepEqual(await read([{ ...op, evidence }]), [{ ...op, evidence }]);
  // Malformed evidence is replaced by null: the operation, which blocks sends, stays listed with every authoritative field.
  for (const malformed of [{ ...evidence, httpStatus: "400" }, { ...evidence, providerIds: { correlation_id: 7 } }, "provider said no", 42])
    assert.deepEqual(await read([{ ...op, evidence: malformed }]), [{ ...op, evidence: null }], JSON.stringify(malformed));
  // The authoritative fields stay strict: a malformed operation is an unavailable read, never a silently shortened list.
  const { client } = serve({ unresolved: os.handler(() => [{ ...op, sent: "no" }]) });
  assert.deepEqual(await client.call("unresolved"), { ok: false, kind: "unavailable" });
});

test("an absolute base reaches a scoped non-browser route through the caller's fetch, which alone adds credentials", async () => {
  const sent: { url: string; authorization: string | null; cookie: string | null }[] = [];
  const handler = new RPCHandler({ overview: os.handler(() => { throw new PublicError("stop"); }), activity: os.handler(() => []) } as never);
  const machine = ownerClient({ base: "https://treasury.example/machine/v1/a/treasury", fetch: async (input, init) => {
    const request = new Request(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: "Bearer tmc_fixture" } });
    sent.push({ url: request.url, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") });
    return (await handler.handle(request, { prefix: "/machine/v1/a/treasury/rpc" })).response ?? new Response("", { status: 404 });
  } });
  assert.deepEqual(await machine.call("activity"), { ok: true, value: [] });
  assert.equal((await machine.call("overview") as { kind: string }).kind, "refused");
  assert.deepEqual(sent.map(s => s.url), ["https://treasury.example/machine/v1/a/treasury/rpc/activity", "https://treasury.example/machine/v1/a/treasury/rpc/overview"]);
  assert.ok(sent.every(s => s.authorization === "Bearer tmc_fixture" && s.cookie === null));
  // Without a caller fetch that adds one, the client sends no credential of its own.
  const bare: Headers[] = [];
  await ownerClient({ base: "https://treasury.example/machine/v1/a/treasury", fetch: async (_input, init) => { bare.push(new Headers(init?.headers)); return Response.json({}, { status: 401 }); } }).call("activity");
  assert.equal(bare[0]?.get("authorization"), null);
});

test("a plain (unencoded) answer keeps its HTTP status as a diagnostic, without becoming a refusal; an encoded refusal keeps its status and code", async () => {
  for (const status of [404, 405, 429, 502]) {
    const client = ownerClient({ base: "/a/t", fetch: async () => Response.json({ error: "Not found" }, { status }) });
    // The handler may never have run (a missing route), but nothing in the answer proves it: the outcome stays unknown.
    assert.deepEqual(await client.call("externalPlan", { swaps: [] }), { ok: false, kind: "unknown", procedure: "externalPlan", identity: { swaps: [] }, httpStatus: status });
    assert.deepEqual(await client.call("activity"), { ok: false, kind: "unavailable", httpStatus: status });
  }
  const { client } = serve({ recover: throwing(new PublicError("Reviewed.")), pay: throwing(new ORPCError("NOT_FOUND", { message: "No such payee" })) });
  assert.deepEqual(await client.call("recover"), { ok: false, kind: "refused", error: "Reviewed.", status: 400, rpcCode: "BAD_REQUEST" });
  const pay = { recipient: "a.near", asset: "nep141:usdc", amount: "1", confidential: true, expectedPolicy: { revision: 1, digest: "sha256:" + "0".repeat(64) } };
  assert.deepEqual(await client.call("pay", pay), { ok: false, kind: "refused", error: "No such payee", status: 404, rpcCode: "NOT_FOUND" });
});

test("oRPC's 400 fallback for unmapped codes can't read as a refusal; every code Proto throws has its own status", async () => {
  const { COMMON_ERROR_STATUS_MAP } = await import("@orpc/client");
  // An app code the server's status map lacks is sent as 400 (oRPC beta.45+). The client classifies by code, so after an
  // action it stays unknown: a 400 never stands in for a refusal by itself.
  const { client } = serve({ cancelPreparedInvoice: os.input(undefined as never).handler(() => { throw new ORPCError("LEDGER_WRITE_FAILED" as never, { message: "x" }); }) });
  const identity = { id: "a".repeat(32) };
  assert.deepEqual(await client.call("cancelPreparedInvoice", identity), { ok: false, kind: "unknown", procedure: "cancelPreparedInvoice", identity });
  // Every ORPCError code constructed in src/ is in the map, so none falls back to 400.
  const { readdirSync, readFileSync } = await import("node:fs");
  const codes = new Set<string>();
  // The whole first argument, so a code chosen by a ternary is read too; one the scan can't read fails the test.
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" }).filter(f => /\.[cm]?[jt]sx?$/.test(f)))
    for (const [, argument] of readFileSync(`src/${file}`, "utf8").matchAll(/new ORPCError\(\s*([^,)]+)[,)]/g)) {
      const literals = [...argument!.matchAll(/["'`]([A-Z_]+)["'`]/g)].map(([, code]) => code!);
      assert.ok(literals.length, `src/${file}: ORPCError code is not a literal: ${argument}`);
      for (const code of literals) codes.add(code);
    }
  assert.ok(codes.size > 0);
  assert.deepEqual([...codes].filter(code => !(code in COMMON_ERROR_STATUS_MAP)), [], "codes without an explicit HTTP status");
});

test("an oRPC error from another copy of @orpc/client keeps its kind", async () => {
  // A separate class, as a bundler that splits @orpc/client from @orpc/client/fetch produces: same name and shape.
  class ORPCError extends Error {
    override name = "ORPCError";
    constructor(readonly code: string, message: string, readonly data: unknown, readonly defined = false) { super(message); }
  }
  const failing = (error: Error) => ownerClient({ base: "/a/payout", fetch: async () => { throw error; } });
  const refused = await failing(new ORPCError("BAD_REQUEST", "Not enough funds", { kind: "refused", code: "insufficient_balance" }))
    .call("pay", { recipient: "payee.near", asset: "usdc", amount: "1", confidential: true, expectedPolicy: { revision: 1, digest: `sha256:${"0".repeat(64)}` } });
  assert.deepEqual(refused.ok === false && [refused.kind, "code" in refused && refused.code], ["refused", "insufficient_balance"]);
  const session = await failing(new ORPCError("UNAUTHORIZED", "Sign in", undefined)).call("overview");
  assert.equal(session.ok === false && session.kind, "session");
  const plain = await failing(new Error("network")).call("overview");
  assert.equal(plain.ok === false && plain.kind, "unavailable", "an ordinary error is still a lost answer");
});
