import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freshDirectory, TSX } from "./fixtures/harness.js";
import { blocksDispatch, readOps } from "../src/ops.js";

/**
 * Concurrent senders on one host against a simulated provider whose admission is not atomic and whose usage is charged
 * only at settlement (test/fixtures/spending-race.ts). What keeps the provider's admitted total within the signed cap
 * here is this side's boundary: one send at a time under the money lock, each followed to a settled status before the
 * lock is released, so the next admission sees the previous charge. It shows nothing about senders that bypass this
 * executor (other hosts, the grant used directly), which only the provider can bound (docs/enforcement.md).
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/spending-race.ts", import.meta.url));
const SENDERS = 6;

freshDirectory("spending-race");

type Result = { outcome: "settled" | "refused" | "error"; code?: string; message?: string; busy: number };

/** Starts every sender, releases them together once all are ready, and returns each one's result. */
async function race(mode: "budget" | "asset", amounts: string[]) {
  const children = amounts.map((amount) => {
    const child = spawn(TSX, [FIXTURE, mode, amount], { cwd: process.cwd() });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => { if (out.includes("ready")) resolve(); });
      child.on("exit", () => reject(new Error(`${mode} ${amount} exited before ready: ${err}`)));
    });
    const done = new Promise<Result>((resolve, reject) => child.on("exit", (status) => {
      if (status !== 0) return reject(new Error(`${mode} ${amount} exited ${status}: ${err}`));
      resolve(JSON.parse(out.trim().split("\n").at(-1)!));
    }));
    return { ready, done };
  });
  await Promise.all(children.map((c) => c.ready));
  writeFileSync("go", "");
  return Promise.all(children.map((c) => c.done));
}

/** What the simulated provider admitted, and what it charged once each settled. */
function provider() {
  const db = new DatabaseSync("provider.db");
  try {
    return db.prepare("SELECT idempotency_key AS key, amount, status, charged FROM operations").all() as
      { key: string; amount: string; status: string; charged: number }[];
  } finally { db.close(); }
}

test("concurrent swaps never get the USD budget admitted past its cap", { timeout: 60_000 }, async () => {
  // Six $10 swaps against a $25 daily budget: two fit.
  const results = await race("budget", Array(SENDERS).fill("10000000"));
  const admitted = provider();
  const usd = admitted.reduce((sum, op) => sum + Number(op.amount) / 1e6, 0);
  assert.ok(usd <= 25, `the provider admitted $${usd} under a $25 budget`);

  assert.deepEqual(results.filter((r) => r.outcome === "error"), []);
  // They did contend for the lock: senders were turned away while another held it.
  assert.ok(results.some((r) => r.busy > 0), "the senders never overlapped");
  assert.equal(admitted.length, 2);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["refused", "refused", "refused", "refused", "settled", "settled"]);
  assert.deepEqual(results.flatMap((r) => r.code ?? []), Array(4).fill("spend_budget_exceeded"));

  // The journal agrees: two settled, four refused by the provider, nothing left unresolved.
  const ops = readOps();
  assert.equal(ops.length, SENDERS);
  assert.deepEqual(ops.filter(blocksDispatch), []);
  assert.deepEqual(new Set(ops.filter((op) => op.status === "SUCCESS").map((op) => op.idempotencyKey)), new Set(admitted.map((op) => op.key)));
  assert.equal(ops.filter((op) => op.refused === "spend_budget_exceeded").length, 4);
});

test("concurrent payouts never get a per-asset cap admitted past it, and one over the per-payment cap never reaches the provider", { timeout: 60_000 }, async () => {
  // Five 20 USDC payouts against a 50 USDC daily cap (two fit), and one of 30 USDC, over the 25 USDC per-payment cap.
  const results = await race("asset", [...Array(SENDERS - 1).fill("20000000"), "30000000"]);
  const admitted = provider();
  const raw = admitted.reduce((sum, op) => sum + BigInt(op.amount), 0n);
  assert.ok(raw <= 50_000_000n, `the provider admitted ${raw} raw USDC under a 50 USDC daily cap`);

  assert.deepEqual(results.filter((r) => r.outcome === "error"), []);
  assert.ok(results.some((r) => r.busy > 0), "the senders never overlapped");
  assert.equal(admitted.length, 2);
  assert.ok(admitted.every((op) => op.amount === "20000000"), "the over-cap payout reached the provider");
  assert.deepEqual(results.flatMap((r) => r.code ?? []).sort(), ["per_transaction_exceeded", "policy_denied", "policy_denied", "policy_denied"]);

  const ops = readOps();
  assert.equal(ops.length, SENDERS);
  assert.deepEqual(ops.filter(blocksDispatch), []);
  // Refused here before it was claimed: the journal shows it never went out, and the provider never saw its key.
  const local = ops.find((op) => op.refused === "per_transaction_exceeded");
  assert.equal(local?.request.amount, "30000000");
  assert.equal(local?.submissionState, "PREPARED");
  assert.ok(!admitted.some((op) => op.key === local.idempotencyKey));
});
