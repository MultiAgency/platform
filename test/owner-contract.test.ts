import assert from "node:assert/strict";
import { test } from "node:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { owner } from "../src/rpc/base.js";
import { readOutput } from "../src/rpc/read-output.js";
import { MoneyLockBusy, UnresolvedOperations } from "../src/lock.js";
import { ownerClient } from "../src/contract/owner-client.js";

/** Procedures implemented from the owner contract, behind a real oRPC handler; the raw wire body is kept. */
function serve(routes: Record<string, unknown>) {
  const handler = new RPCHandler(routes as never);
  const bodies: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { response } = await handler.handle(new Request(input, init), { prefix: "/a/x/rpc" });
    bodies.push(await response!.clone().text());
    return response!;
  };
  const client = createORPCClient(new RPCLink({ url: "/a/x/rpc", fetch: (url, init) => fetch(new URL(url, "http://localhost"), init) })) as unknown as Record<string, unknown>;
  /** The plain oRPC client (no ownerClient classification), by procedure path. */
  const raw = (path: string, input?: unknown) => (path.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], client) as (input?: unknown) => Promise<unknown>)(input);
  return { fetch, bodies, raw };
}

test("contract-implemented mutations are not output-validated: an off-schema answer arrives unchanged", async () => {
  const answer = { correlationId: "c", unexpected: { nested: [1, 2] } };
  const { raw, bodies } = serve({ owner: { submit: owner.owner.submit.handler(() => answer as never) } });
  assert.deepEqual(await raw("owner/submit", { correlationId: "c", signedData: {} }), answer);
  assert.deepEqual(JSON.parse(bodies[0]!).json, answer, "nothing stripped or rejected on the wire");
});

test("contract-implemented reads validate only: extra fields pass unchanged, drift fails loudly", async () => {
  const unresolved = [{ key: "k", at: "2026-10-17T00:00:00.000Z", kind: "payout", request: {}, status: null, sent: false, extra: true }];
  const ok = serve({ unresolved: owner.unresolved.use(readOutput("unresolved")).handler(() => unresolved as never) });
  assert.deepEqual(await ok.raw("unresolved"), unresolved);
  const drift = serve({ unresolved: owner.unresolved.use(readOutput("unresolved")).handler(() => [{ key: 1 }] as never) });
  await assert.rejects(drift.raw("unresolved"), (error: unknown) => error instanceof ORPCError && error.code === "INTERNAL_SERVER_ERROR");
});

test("typed errors arrive as defined errors with their kind, and their data is never stripped", async () => {
  // A refusal the provider's answer proves (nothing executed), so it stays typed even after a mutation.
  const provider = new AgentApiError(403, { errors: [{ status: "403", code: "spend_budget_exceeded", title: "Budget", meta: { budget_remaining_usd: "1.50" } }] } as never);
  const cases: [unknown, string, Record<string, unknown>][] = [
    [new UnresolvedOperations([]), "CONFLICT", { kind: "unresolved" }],
    [new MoneyLockBusy(), "CONFLICT", { kind: "busy" }],
    [provider, "BAD_REQUEST", { kind: "provider" }],
  ];
  for (const [thrown, code, data] of cases) {
    const { raw, bodies } = serve({ owner: { submit: owner.owner.submit.handler(() => { throw thrown; }) } });
    await assert.rejects(raw("owner/submit", { correlationId: "c", signedData: {} }), (error: unknown) =>
      error instanceof ORPCError && error.code === code && error.defined === true && Object.entries(data).every(([k, v]) => (error.data as Record<string, unknown>)[k] === v));
    const wire = JSON.parse(bodies[0]!).json as { defined: boolean; data: Record<string, unknown> };
    assert.equal(wire.defined, true);
    if (thrown === provider) assert.ok("availableAt" in wire.data && "code" in wire.data, "provider details kept");
  }
  // A stream's typed failure before its first event keeps its kind through ownerClient.
  const { fetch } = serve({ executePlan: owner.executePlan.handler(async function* () { throw new UnresolvedOperations([]); }) });
  const events = ownerClient({ base: "/a/x", fetch }).stream("executePlan", { planId: "00000000-0000-4000-8000-000000000000" });
  let next = await events.next(); while (!next.done) next = await events.next();
  assert.equal((next.value as { kind: string }).kind, "unresolved");
});

test("a provider refusal while preparing an owner action is typed; after a submission it stays untyped", async () => {
  // A code no proven list names: after owner/submit it may follow an effect, so it stays untyped (the client reads unknown).
  const refused = () => new AgentApiError(400, { errors: [{ status: "400", code: "unsupported_by_simulator", title: "Unsupported", meta: { retryable: false } }] } as never);
  const prepared = serve({ owner: { prepare: owner.owner.prepare.handler(() => { throw refused(); }) } });
  await assert.rejects(prepared.raw("owner/prepare", { action: { type: "grant_issue", label: "payout" }, signer: "wallet" }), (error: unknown) =>
    error instanceof ORPCError && error.code === "BAD_REQUEST" && error.defined === true
      && (error.data as Record<string, unknown>).kind === "provider" && (error.data as Record<string, unknown>).code === "unsupported_by_simulator");
  const submitted = serve({ owner: { submit: owner.owner.submit.handler(() => { throw refused(); }) } });
  await assert.rejects(submitted.raw("owner/submit", { correlationId: "c", signedData: {} }), (error: unknown) =>
    error instanceof ORPCError && error.code === "INTERNAL_SERVER_ERROR");
});

test("input validation failures stay undefined errors with their issues (not matched to a kind)", async () => {
  const { raw, bodies } = serve({ executePlan: owner.executePlan.handler(async function* () { yield undefined as never; }) });
  await assert.rejects(raw("executePlan", { planId: "not-a-uuid" }), (error: unknown) => error instanceof ORPCError && error.code === "BAD_REQUEST" && error.defined === false);
  assert.ok(Array.isArray(JSON.parse(bodies[0]!).json.data.issues));
});
