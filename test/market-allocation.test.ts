import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKey } from "near-kit";
import { allocationText, parseAllocation, type AllocationMessage } from "../src/market/allocation-types.js";
import {fixtureMessage,signedFixture} from "./fixtures/market-allocation.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { freshDirectory } from "./fixtures/harness.js";
import { recordMarketBinding, record, claimSubmission, recordMarketLanding, marketStageKey, recordMarketAllocation, readMarketBindings, readOps, opsLog } from "../src/ops.js";
import { requestKey } from "../src/request-key.js";
import { ASSETS } from "../src/policy.js";
import { pendingMarketFunding } from "../src/market/binding-guard.js";
import { parseJournalHistory } from "../src/journal-history.js";
import { readOps as oldReadOps } from "./fixtures/ops-before-allocation.js";
import { createHash } from "node:crypto";
import { allocationReservations } from "../src/market/allocation-reservation.js";
import { HostedAgents } from "../src/gateway/hosted-agents.js";

freshDirectory("market-allocation");
test("allocation's read-only registry agrees with hosted ownership and refuses corrupt reservations", () => {
  const owner = "owner.near", deployment = "market", organization = "review";
  const name = `own-${createHash("sha256").update(`app:${deployment}:${organization}:${owner}:market`).digest("hex").slice(0, 24)}`;
  const entry = { owner, kind: "wallet", area: "market", name, port: 9001, deployment, organization };
  const save = (entries: unknown[]) => writeFileSync("apps.json", JSON.stringify({ version: 1, entries }));
  writeFileSync(`${name}.env`, ""); save([entry]);
  const canonical = () => new HostedAgents(process.cwd(), []).list().map(({ executor: _executor, ...e }) => e);
  assert.deepEqual(allocationReservations(process.cwd()), canonical());
  const release = { ...entry, agentId: "agent", at: new Date().toISOString(), archiveCorrelationId: null, state: "releasing" };
  writeFileSync("released.json", JSON.stringify({ version: 1, entries: [release] }));
  assert.deepEqual(allocationReservations(process.cwd()), canonical());
  writeFileSync("released.json", JSON.stringify({ version: 1, entries: [] }));
  for (const entries of [[entry, entry], [{ ...entry, name: "wrong" }], [{ ...entry, kind: "unknown" }]]) {
    save(entries); assert.throws(() => allocationReservations(process.cwd())); assert.throws(canonical);
  }
});
const writerFile = fileURLToPath(new URL("./fixtures/market-allocation-writer.ts", import.meta.url));
const loader = import.meta.resolve("tsx");
function writer(file: string, phase = "normal") {
  const child = spawn(process.execPath, ["--import", loader, writerFile, file, phase], { cwd: process.cwd(), env: process.env, timeout: 30_000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const done = new Promise<{ code: number | null; signal: string | null; reply?: { recorded: boolean; reason?: string } }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 && signal !== "SIGKILL") return reject(new Error(`Allocation fixture failed: ${stderr}`));
      resolve({ code, signal, ...(stdout.trim() && { reply: JSON.parse(stdout) }) });
    });
  });
  return { child, done };
}
function provenSource() {
  const message = fixtureMessage();
  message.agentId = process.env.AGENT_ID!;
  message.target.approved.asset = ASSETS.USDC.slice(7);
  const actor = "owner:owner.near", requestId = "proof", key = requestKey(actor, requestId);
  message.sourceBindingKey = key;
  recordMarketBinding({ idempotencyKey: key, actor, requestId, brief: message.target.brief,
    approved: { ...message.target.approved, amount: "10000" }, paymentAccount: message.paymentAccount,
    publicKey: message.paymentPublicKey, fundingOnly: true });
  for (const stage of ["open", "usdc"] as const) {
    const idempotencyKey = marketStageKey(key, stage);
    const request = { asset: stage === "open" ? ASSETS.wNEAR : ASSETS.USDC,
      amount: stage === "open" ? "20000000000000000000000" : "10000", chain: "near", recipient: message.paymentAccount, confidential: true };
    record({ at: new Date().toISOString(), idempotencyKey, kind: "market-topup", method: "withdraw", request, journalVersion: 2 });
    claimSubmission(idempotencyKey, request);
    record({ idempotencyKey, correlation_id: stage, status: "SUCCESS" });
    const proof = stage === "open" ? message.sourceOpen : message.sourceUsdc;
    recordMarketLanding({ bindingKey: key, stage, ...proof });
  }
  return message;
}


test("a disposition signature binds the exact source and target; changed fields cannot spend", () => {
  const message = fixtureMessage(), signed = signedFixture(message);
  assert.deepEqual(parseAllocation(signed), message);
  for (const change of [{ ownerAccount: "other.near" }, { sourceBindingKey: "other" }, { host: "other.example" },
    { sourceUsdcAmount: "10001" }, { target: { ...message.target, requestId: "another" } }]) {
    assert.throws(() => parseAllocation({ ...signed, message: allocationText({ ...message, ...change }) }));
  }
  assert.throws(() => parseAllocation({ ...signed, publicKey: generateKey().publicKey.toString() }));
  assert.throws(() => allocationText({ ...message, target: { ...message.target, brief: "changed" } }));
  assert.throws(() => allocationText({ ...message, nonce: "AA==" }));
});

test("one signed append-only allocation preserves fundingOnly and admits only the exact target", () => {
  const message = provenSource(), signed = signedFixture(message);
  const target = requestKey(message.target.actor, message.target.requestId);
  assert.ok(pendingMarketFunding(message.paymentAccount, target));
  recordMarketAllocation(signed);
  assert.equal(readMarketBindings()[0]?.fundingOnly, true);
  assert.equal(readMarketBindings().length, 2);
  assert.equal(pendingMarketFunding(message.paymentAccount, target), null);
  assert.ok(pendingMarketFunding(message.paymentAccount));
  assert.ok(pendingMarketFunding(message.paymentAccount, "another-request"));
  assert.equal(readOps().length, 2, "allocation is not a money action");
  const source = readFileSync(opsLog(), "utf8");
  recordMarketAllocation(signed);
  assert.equal(readFileSync(opsLog(), "utf8"), source, "same signed reply is idempotent");
  assert.throws(() => oldReadOps(), /unsupported record shape/);
  assert.equal(readFileSync(opsLog(), "utf8"), source, "old reader cannot rewrite the new journal");
  const exported = parseJournalHistory(message.agentId, source);
  assert.ok(exported.gaps.some(g => g.ref === "market-allocation"));
  assert.equal(JSON.stringify(exported).includes(signed.signature), false);
});

test("renewal changes authority only, while retargeting and replayed old authorization refuse without writes", () => {
  const message = provenSource();
  const first = signedFixture(message);
  recordMarketAllocation(first);
  const second = signedFixture({ ...message, nonce: Buffer.alloc(32, 2).toString("base64"), reviewedPolicy: { ...message.reviewedPolicy, revision: 3 } });
  recordMarketAllocation(second);
  const journal = readFileSync(opsLog(), "utf8");
  assert.throws(() => recordMarketAllocation(first), /nonce/);
  assert.throws(() => recordMarketAllocation(signedFixture({ ...message, nonce: Buffer.alloc(32, 3).toString("base64"),
    target: { ...message.target, requestId: "changed" } })), /cannot change/);
  assert.equal(readFileSync(opsLog(), "utf8"), journal);
  assert.equal(readMarketBindings()[1]?.fundingSource?.signature, second.signature);
});

test("a target already bound to another key refuses without poisoning the journal", () => {
  const message = provenSource();
  recordMarketBinding({ idempotencyKey: requestKey(message.target.actor, message.target.requestId), ...message.target,
    paymentAccount: "c".repeat(64), publicKey: message.paymentPublicKey });
  const journal = readFileSync(opsLog(), "utf8");
  assert.throws(() => recordMarketAllocation(signedFixture(message)), /target.*bound/i);
  assert.equal(readFileSync(opsLog(), "utf8"), journal);
  assert.equal(readMarketBindings().length, 2);
});

test("missing or altered proofs and contradictory source amounts cannot create an allocation", () => {
  const message = provenSource(), journal = readFileSync(opsLog(), "utf8");
  assert.throws(() => recordMarketAllocation(signedFixture({ ...message, sourceUsdc: { ...message.sourceUsdc, destinationTxHash: "wrong" } })), /proof changed/);
  assert.throws(() => recordMarketAllocation(signedFixture({ ...message, sourceUsdcAmount: "9999", maxTopUpUsdc: "240001" })), /isolated observation/);
  assert.equal(readFileSync(opsLog(), "utf8"), journal);
  recordMarketAllocation(signedFixture(message));
  const rows = readFileSync(opsLog(), "utf8").trim().split("\n");
  rows.push(rows.at(-1)!);
  writeFileSync(opsLog(), rows.join("\n") + "\n");
  assert.throws(() => readOps(), /repeated allocation/);
});

test("concurrent allocator processes admit only one exact target under the real money lock", { timeout: 45_000 }, async () => {
  const m = provenSource(), first = join(process.cwd(), "first.json"), second = join(process.cwd(), "second.json");
  writeFileSync(first, JSON.stringify(signedFixture(m)));
  writeFileSync(second, JSON.stringify(signedFixture({ ...m, nonce: Buffer.alloc(32, 2).toString("base64"), target: { ...m.target, requestId: "competitor" } })));
  const a = writer(first, "hold");
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync("allocation-held")) {
      assert.ok(Date.now() < deadline, "allocator must reach durable commit");
      await Promise.race([setTimeout(10), a.done.then(() => { throw new Error("Allocator exited before barrier"); })]);
    }
    const b = await writer(second).done;
    assert.equal(b.reply?.recorded, false);
    writeFileSync("allocation-release", "release");
    assert.equal((await a.done).reply?.recorded, true);
    assert.equal((await writer(second).done).reply?.recorded, false, "lock release never permits retargeting");
    assert.equal(readMarketBindings().length, 2);
    assert.equal(readMarketBindings()[1]?.requestId, m.target.requestId);
  } finally { if (a.child.exitCode === null) a.child.kill(); await Promise.allSettled([a.done]); }
});

for (const phase of ["before", "after"] as const) test(`allocator SIGKILL ${phase} append preserves source and replays once`, { timeout: 45_000 }, async () => {
  const m = provenSource(), file = join(process.cwd(), "allocation.json");
  writeFileSync(file, JSON.stringify(signedFixture(m)));
  const original = readFileSync(opsLog(), "utf8");
  assert.equal((await writer(file, phase).done).signal, "SIGKILL");
  if (phase === "before") assert.equal(readFileSync(opsLog(), "utf8"), original);
  else assert.equal(readMarketBindings().length, 2);
  // Real stale-lock recovery, not mocked timers or lock deletion.
  await setTimeout(11_000);
  assert.equal((await writer(file).done).reply?.recorded, true);
  assert.equal(readMarketBindings().length, 2);
  assert.equal(readMarketBindings()[0]?.fundingOnly, true);
  assert.equal(readOps().length, 2);
  assert.equal(readFileSync(opsLog(), "utf8").split("\n").filter(s => s.includes('"kind":"market-allocation"')).length, 1);
});
