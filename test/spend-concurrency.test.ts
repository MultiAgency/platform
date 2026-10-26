import assert from "node:assert/strict";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { afterEach, beforeEach, mock, test } from "node:test";
import { type Action, dispatch } from "../src/agent.js";
import { api } from "../src/api.js";
import { acquireMoneyLock, MoneyLockBusy, UnresolvedOperations } from "../src/lock.js";
import { readOps } from "../src/ops.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

// The local half of the spending envelope: whatever the provider enforces, this executor never has two money
// actions in flight on one host, and an unproven outcome stops every later send. The provider's own budget and
// per-asset counters are the open cases in docs/enforcement.md (provider-questions.md).
const action: Action = { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "fixture.near", confidential: true } };
const policy = policyView(payoutPolicy(["fixture.near"]));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Lock = Awaited<ReturnType<typeof acquireMoneyLock>>;
let calls: string[], inFlight: number, maxInFlight: number, status: string, unknownOutcome: boolean;

freshDirectory("spend-concurrency");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  calls = []; inFlight = 0; maxInFlight = 0; status = "SUCCESS"; unknownOutcome = false;
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policy);
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status }));
  const send = async (_id: string, _request: unknown, options: { idempotencyKey: string }) => {
    calls.push(options.idempotencyKey);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await sleep(20);
    inFlight--;
    if (unknownOutcome) throw new AgentApiError(500, { errors: [{ status: "500", code: "internal_error", title: "Internal error" }], meta: {} });
    return { correlation_id: `op-${calls.length}` };
  };
  mock.method(api, "forGrant", () => ({ transfer: send, swap: send, shield: send, unshield: send }));
});
afterEach(() => mock.restoreAll());

test("of many simultaneous attempts to start a money action, exactly one gets the lock", async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => acquireMoneyLock()));
  const winners = attempts.filter((a): a is PromiseFulfilledResult<Lock> => a.status === "fulfilled");
  const losers = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 15);
  for (const loser of losers) assert.ok(loser.reason instanceof MoneyLockBusy);
  await winners[0]!.value.release();
});

test("concurrent workers never overlap a send, and every send has its own identity", async () => {
  // Each worker retries until it has sent once: the provider sees them one at a time.
  const worker = async () => {
    for (;;) {
      let lock: Lock;
      try { lock = await acquireMoneyLock(); } catch (error) { if (error instanceof MoneyLockBusy) { await sleep(5); continue; } throw error; }
      try { await dispatch(lock, "fixture", action); return; } finally { await lock.release(); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  assert.equal(calls.length, 6);
  assert.equal(maxInFlight, 1, "two sends were in flight at once");
  assert.equal(new Set(calls).size, 6, "an idempotency key was reused");
});

test("a send with an unproven outcome stops every later attempt, however many arrive at once", async () => {
  unknownOutcome = true;
  const first = await acquireMoneyLock();
  try { await assert.rejects(dispatch(first, "fixture", action), AgentApiError); } finally { await first.release(); }
  assert.equal(calls.length, 1);
  assert.equal(readOps().filter((op) => !op.refused && op.status !== "SUCCESS").length, 1);
  const later = await Promise.allSettled(Array.from({ length: 8 }, () => acquireMoneyLock()));
  // An attempt is refused as unresolved, or as busy while another attempt is still checking: never admitted.
  const reasons = later.map((attempt) => { assert.equal(attempt.status, "rejected"); return (attempt as PromiseRejectedResult).reason; });
  for (const reason of reasons) assert.ok(reason instanceof UnresolvedOperations || reason instanceof MoneyLockBusy);
  assert.ok(reasons.some((reason) => reason instanceof UnresolvedOperations));
  assert.equal(calls.length, 1, "nothing more was sent while the outcome was unproven");
});
