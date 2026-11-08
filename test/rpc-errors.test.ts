import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import { LocalRefusal } from "../src/agent.js";
import { api } from "../src/api.js";
import { CompensationError } from "../src/compensation-store.js";
import { MoneyLockBusy, UnresolvedOperations } from "../src/lock.js";
import { mandateDigest } from "../src/mandate.js";
import { readOps } from "../src/ops.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { PublicError } from "../src/public-error.js";
import { os } from "../src/rpc/base.js";
import { router } from "../src/router.js";
import { WorkOrderRefusal } from "../src/work-order-protocol.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

freshDirectory("rpc-errors");
const policy = policyView(payoutPolicy(["fixture.near"]));
let calls: string[];
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  calls = [];
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policy);
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "UNCERTAIN" }));
  const send = async (_id: string, _request: unknown, options: { idempotencyKey: string }) => { calls.push(options.idempotencyKey); return { correlation_id: "fixture-op" }; };
  mock.method(api, "forGrant", () => ({ transfer: send, swap: send, shield: send, unshield: send }));
});
afterEach(() => mock.restoreAll());

/** Recovery is decided from `data.kind`, never from message text. */
async function rejection(error: unknown) {
  const client = createRouterClient({ boom: os.handler(() => { throw error; }) });
  try { await client.boom(); } catch (thrown) { assert.ok(thrown instanceof ORPCError); return { code: thrown.code, data: thrown.data as Record<string, unknown> | undefined, message: thrown.message }; }
  assert.fail("expected a rejection");
}

test("each pre-send refusal reaches the client as a distinguishable typed kind", async () => {
  const unresolved = await rejection(new UnresolvedOperations([{ idempotencyKey: "fixture:earlier" } as never]));
  assert.deepEqual([unresolved.code, unresolved.data], ["CONFLICT", { kind: "unresolved" }]);
  assert.doesNotMatch(unresolved.message, /fixture:earlier|pnpm/, "operation keys and operator commands stay out of the public message");
  assert.deepEqual([(await rejection(new MoneyLockBusy())).code, (await rejection(new MoneyLockBusy())).data], ["CONFLICT", { kind: "busy" }]);
  assert.deepEqual((await rejection(new WorkOrderRefusal("work_order_not_ready", "Not ready."))).data, { kind: "refused", code: "work_order_not_ready" });
  assert.deepEqual((await rejection(new CompensationError("stale_request", "Refresh."))).data, { kind: "refused", code: "stale_request" });
  const local = await rejection(new LocalRefusal("grant_missing", "No live grant is held for this agent"));
  assert.deepEqual([local.code, local.data, local.message], ["BAD_REQUEST", { kind: "refused", code: "grant_missing" }, "No live grant is held for this agent"]);
  assert.deepEqual((await rejection(new PublicError("Reviewed guidance."))).data, { kind: "refused" });
  const internal = await rejection(new Error("private detail /var/secret"));
  assert.deepEqual([internal.code, internal.data], ["INTERNAL_SERVER_ERROR", undefined]);
});

test("an unresolved earlier operation refuses a new payment over RPC as CONFLICT/unresolved and sends nothing", async () => {
  const client = createRouterClient(router);
  const input = { recipient: "fixture.near", asset: ASSETS.USDC, amount: "1", confidential: true, expectedPolicy: { revision: policy.revision, digest: mandateDigest(policy.policy!) } };
  await client.pay(input);
  assert.equal(calls.length, 1, "the first payment was sent and its outcome stays uncertain");
  await assert.rejects(client.pay(input),
    (error: unknown) => error instanceof ORPCError && error.code === "CONFLICT" && (error.data as { kind?: string })?.kind === "unresolved");
  assert.equal(calls.length, 1, "nothing new was sent");
  assert.equal(readOps().length, 1, "no new operation was recorded");
});

/** The thrown oRPC error of a call or stream, as the owner's client would see it. */
async function refusalOf(call: () => Promise<unknown>) {
  try {
    const result = await call();
    if (result && typeof result === "object" && Symbol.asyncIterator in result) for await (const _ of result as AsyncIterable<unknown>) { /* drain */ }
  } catch (thrown) { assert.ok(thrown instanceof ORPCError); return [thrown.code, thrown.data]; }
  assert.fail("expected a refusal");
}

test("pre-send guards that act on nothing are refused, not unknown: unknown plan, unknown account, stale strategy review", async () => {
  const client = createRouterClient(router);
  assert.deepEqual(await refusalOf(() => client.executePlan({ planId: "00000000-0000-4000-8000-000000000000" })), ["BAD_REQUEST", { kind: "refused" }]);

  // The chain answers that the account does not exist (the RPC shape near-kit decodes as AccountDoesNotExistError).
  mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const { id } = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "nobody.near" } }, code: -32000, message: "Server error" } });
  });
  assert.deepEqual(await refusalOf(() => client.treasury.link({ accountId: "nobody.near" })), ["BAD_REQUEST", { kind: "refused" }]);
  offline();

  mock.method(api, "getPolicy", async () => policyView({ ...payoutPolicy(["fixture.near"]), actions: ["swap"] }));
  assert.deepEqual(await refusalOf(() => client.owner.prepare({ action: { type: "grant_issue", label: "treasury", expectedStrategyDigest: `sha256:${"0".repeat(64)}` }, signer: "wallet" })),
    ["BAD_REQUEST", { kind: "refused" }]);
  assert.equal(calls.length, 0, "nothing was sent");
});

test("an approve-only copy refuses a payment as refused, before recording or sending anything", async () => {
  const client = createRouterClient(router);
  const input = { recipient: "fixture.near", asset: ASSETS.USDC, amount: "1", confidential: true, expectedPolicy: { revision: policy.revision, digest: mandateDigest(policy.policy!) } };
  process.env.EXECUTOR = "off";
  try {
    await assert.rejects(client.pay(input),
      (error: unknown) => error instanceof ORPCError && error.code === "BAD_REQUEST" && (error.data as { kind?: string })?.kind === "refused");
  } finally { delete process.env.EXECUTOR; }
  assert.equal(calls.length, 0, "nothing was sent");
  assert.equal(readOps().length, 0, "nothing was recorded");
});
