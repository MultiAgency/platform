import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatch } from "../src/agent.js";
import { held } from "../src/payouts.js";
import { recover } from "../src/recover.js";
import { api } from "../src/api.js";
import { acquireMoneyLock, MoneyLockBusy, STALE_MS, UnresolvedOperations } from "../src/lock.js";
import { opsLog, readOps, settle } from "../src/ops.js";
import { freshDirectory, TSX } from "./fixtures/harness.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/lock.ts", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every test gets an empty directory: the lock and the ops log live in the working directory.
freshDirectory("money-lock");

/** Runs the fixture in another process in the current directory; returns what it printed. */
const child = (mode: string) => {
  const result = spawnSync(TSX, [FIXTURE, mode], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined, `${mode}: ${result.error ?? result.stderr}`);
  if (mode !== "crash-after-log") assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
  return result.stdout.trim();
};

test("another process can't take the lock while it is held", async () => {
  const lock = await acquireMoneyLock();
  assert.equal(child("try"), "busy");
  await lock.release();
  assert.equal(child("try"), "acquired");
});

test("a second run in the same process can't take it either", async () => {
  const lock = await acquireMoneyLock();
  await assert.rejects(acquireMoneyLock(), MoneyLockBusy);
  await lock.release();
});

test("a crashed holder's lock is taken over only once it goes stale", { timeout: 30_000 }, async () => {
  const holder = spawn(TSX, [FIXTURE, "hold"], { cwd: process.cwd() });
  // tsx runs the script in a child of its own: kill that process, the one holding the lock.
  const pid = await new Promise<number>((resolve) =>
    holder.stdout.on("data", (d) => {
      const match = /held (\d+)/.exec(String(d));
      if (match) resolve(Number(match[1]));
    }),
  );
  process.kill(pid, "SIGKILL");
  await new Promise((resolve) => holder.on("exit", resolve));
  await assert.rejects(acquireMoneyLock(), MoneyLockBusy);
  await sleep(STALE_MS + 1_000);
  const lock = await acquireMoneyLock();
  assert.ok(lock.held);
  await lock.release();
});

test("an operation cut off by a crash blocks every new money action after restart", async () => {
  assert.equal(child("crash-after-log"), "");
  const [op] = readOps();
  assert.equal(op?.idempotencyKey, "swap:crashed");
  // The crashed process never released its lock; once stale, the next run is refused anyway.
  await sleep(STALE_MS + 1_000);
  await assert.rejects(acquireMoneyLock(), (error: unknown) => {
    assert.ok(error instanceof UnresolvedOperations);
    assert.deepEqual(error.ops.map((o) => o.idempotencyKey), ["swap:crashed"]);
    return true;
  });
  assert.equal(child("try"), "unresolved");
  // Only reconcile may take the lock, to resolve it under the original key.
  const lock = await acquireMoneyLock({ reconcile: true });
  await lock.release();
});

test("only proven outcomes resolve an operation", async () => {
  const request = (key: string) => JSON.stringify({ at: "2026-10-14T00:00:00Z", idempotencyKey: key, kind: "k", method: "swap", request: {} });
  writeFileSync(
    opsLog(),
    [
      request("refused"),
      JSON.stringify({ idempotencyKey: "refused", refused: "policy_denied" }),
      request("settled"),
      JSON.stringify({ idempotencyKey: "settled", correlation_id: "op_1", status: "SENT" }),
      JSON.stringify({ idempotencyKey: "settled", correlation_id: "op_1", status: "SUCCESS" }),
      request("uncertain"),
      JSON.stringify({ idempotencyKey: "uncertain", correlation_id: "op_2", status: "UNCERTAIN" }),
      request("sent"),
      JSON.stringify({ idempotencyKey: "sent", correlation_id: "op_3", status: "SENT" }),
      "",
    ].join("\n"),
  );
  await assert.rejects(acquireMoneyLock(), (error: unknown) => {
    assert.ok(error instanceof UnresolvedOperations);
    assert.deepEqual(error.ops.map((o) => o.idempotencyKey), ["uncertain", "sent"]);
    return true;
  });
});

test("an action held for the owner's approval doesn't block, and settles by its correlation id", async () => {
  writeFileSync(
    opsLog(),
    [
      JSON.stringify({ at: "2026-10-14T00:00:00Z", idempotencyKey: "held", kind: "payout", method: "transfer", request: {} }),
      JSON.stringify({ idempotencyKey: "held", correlation_id: "op_held", status: "PENDING_APPROVAL" }),
      "",
    ].join("\n"),
  );
  const lock = await acquireMoneyLock();
  await lock.release();
  settle("op_held", "SUCCESS");
  assert.equal(readOps()[0]?.status, "SUCCESS");
  // Outcome lines are stamped when written, so the log shows how long resolution took.
  const last = JSON.parse(readFileSync(opsLog(), "utf8").trimEnd().split("\n").at(-1)!);
  assert.ok(!Number.isNaN(Date.parse(last.at)));
});

test("a released held action blocks new sends until reconciliation proves its outcome", async () => {
  writeFileSync(
    opsLog(),
    [
      JSON.stringify({ at: "2026-10-14T00:00:00Z", idempotencyKey: "held", kind: "payout", method: "transfer", request: {} }),
      JSON.stringify({ idempotencyKey: "held", correlation_id: "op_held", status: "PENDING_APPROVAL" }),
      "",
    ].join("\n"),
  );
  // Released by a vote, not settled yet: the status read in between is not an outcome.
  Object.assign(api, {
    getStatus: async () => ({ correlation_id: "op_held", status: "PROCESSING", details: null }),
    getHistory: async () => ({ data: [], next_cursor: null }),
  });
  assert.deepEqual(await held(), []);
  assert.equal(readOps()[0]?.status, "PROCESSING");
  await assert.rejects(acquireMoneyLock(), UnresolvedOperations);

  // An outcome nobody can vouch for is recorded, and blocks until reconciled.
  Object.assign(api, { getStatus: async () => ({ correlation_id: "op_held", status: "UNCERTAIN", details: null }) });
  await recover();
  assert.equal(readOps()[0]?.status, "UNCERTAIN");
  await assert.rejects(acquireMoneyLock(), UnresolvedOperations);

  Object.assign(api, { getStatus: async () => ({ correlation_id: "op_held", status: "SUCCESS", details: null }) });
  await recover();
  assert.equal(readOps()[0]?.status, "SUCCESS");
  await (await acquireMoneyLock()).release();
});

test("a payout another instance filed is listed from the API's history and never written here", async () => {
  writeFileSync(opsLog(), "");
  const remote = { correlation_id: "op_remote", agent_id: process.env.AGENT_ID, type: "transfer", status: "PENDING_APPROVAL", created_at: new Date().toISOString(), details: { approval_id: "appr-1" } };
  Object.assign(api, {
    getHistory: async () => ({ data: [remote, { ...remote, correlation_id: "op_done", status: "SUCCESS" }], next_cursor: null }),
    getApproval: async () => ({ request_data: { to: "payee.near", token: "nep141:usdc", amount: "1000000" } }),
  });
  assert.deepEqual(await held(), [
    {
      at: remote.created_at,
      kind: "remote",
      request: { asset: "nep141:usdc", amount: "1000000", recipient: "payee.near", confidential: true },
      correlationId: "op_remote",
      approvalId: "appr-1",
    },
  ]);
  // A vote releasing it settles by correlation id, which matches no local line: nothing is created.
  settle("op_remote", "SUCCESS");
  assert.deepEqual(readOps(), []);

  // Without the history, this instance's own held actions are still listed.
  Object.assign(api, { getHistory: async () => { throw new Error("down"); } });
  assert.deepEqual(await held(), []);
});

test("an approve-only instance (EXECUTOR=off) refuses to send, before logging anything", async () => {
  const lock = await acquireMoneyLock();
  process.env.EXECUTOR = "off";
  try {
    await assert.rejects(
      dispatch(lock, "test", { method: "transfer", request: { asset: "a", amount: "1", recipient: "b.near", confidential: true } }),
      /only approves/,
    );
    assert.deepEqual(readOps(), []);
  } finally {
    delete process.env.EXECUTOR;
    await lock.release();
  }
});

test("dispatch refuses to send without a held lock, before logging anything", async () => {
  const released = await acquireMoneyLock();
  await released.release();
  await assert.rejects(
    dispatch(released, "test", { method: "swap", request: { origin_asset: "a", destination_asset: "b", amount: "1" } }),
    /money lock/,
  );
  assert.deepEqual(readOps(), []);
});

test("a stopping process starts no new send and waits for the one in flight", () => {
  assert.deepEqual(child("stop").split("\n"), ["dispatch busy", "acquire busy", "idle while held false", "idle once released true"]);
  assert.equal(child("try"), "acquired", "the lock was released, and another process sends again");
  assert.deepEqual(readOps(), []);
});
