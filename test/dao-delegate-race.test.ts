import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodeSignedDelegateAction, generateKey } from "near-kit";
import { temporaryDirectories, TSX } from "./fixtures/harness.js";

const scratch = temporaryDirectories();

const fixture = fileURLToPath(new URL("./fixtures/dao-delegate-race.ts", import.meta.url));
const key = "ed25519:11111111111111111111111111111111";
function start(dir: string, id: string, publicKey = key, barrier = "wait", nonce = 41) {
  writeFileSync(join(dir, `.env.${id}`), `AGENT_ID=agent-${id}\nTREASURY_ACCOUNT=fixture.near\n`);
  const child = spawn(TSX, [fixture, id, publicKey, barrier, String(nonce)], {
    cwd: dir, env: { ...process.env, ENV_FILE: `.env.${id}` }, timeout: 30_000,
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise<{ prepared?: string; refused?: string; recovered?: unknown }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`Fixture exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  return { child, done };
}
function saved(dir: string, id: string) {
  const record = JSON.parse(readFileSync(join(dir, ".owner-intents", `.env.${id}.json`), "utf8"))[id];
  const action = decodeSignedDelegateAction(Buffer.from(record.dao.delegate, "base64")).signedDelegate.delegateAction;
  return { record, action };
}

test("simultaneous instances cannot persist competing delegates for one owner", { timeout: 40_000 }, async () => {
  const dir = scratch.create("dao-delegate-race");
  const writers = [start(dir, "one")];
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, "one.checked"))) {
      assert.ok(Date.now() < deadline, "first instance must reach construction");
      await Promise.race([setTimeout(10), writers[0]!.done.then(() => { throw new Error("Writer exited before barrier"); })]);
    }
    const independent = start(dir, "other-owner", generateKey().publicKey.toString(), "none");
    assert.deepEqual(await independent.done, { prepared: "other-owner" }, "another owner must not wait for this key's lock");
    writers.push(start(dir, "two", key, "none"));
    const competing = await writers[1]!.done;
    assert.equal(writers[0]!.child.exitCode, null, "the first instance must still hold the owner's lock while the contender runs");
    assert.match(competing.refused ?? "", /Another owner action.*delegate/);
    assert.equal(existsSync(join(dir, "two.checked")), false, "the contender must not construct a delegate");
    assert.equal(existsSync(join(dir, ".owner-intents", ".env.two.json")), false);
    writeFileSync(join(dir, "release"), "go");
    assert.deepEqual(await writers[0]!.done, { prepared: "one" });
    const a = saved(dir, "one");
    assert.equal(a.record.stage, "prepared");
    assert.equal(a.action.nonce, 42n);
  } finally {
    for (const writer of writers) if (writer.child.exitCode === null) writer.child.kill();
    await Promise.allSettled(writers.map(writer => writer.done));
  }
});

test("lost owner-key lock refuses persistence and a later process can retry", async () => {
  const dir = scratch.create("dao-delegate-lock-loss");
  const result = await start(dir, "one", key, "lose-lock").done;
  assert.match(result.refused ?? "", /delegate preparation lock lost/);
  assert.equal(existsSync(join(dir, ".owner-intents", ".env.one.json")), false);
  assert.deepEqual(await start(dir, "two", key, "none").done, { prepared: "two" });
});

for (const outcome of ["success", "failed", "payout", "unknown"]) test(`peer recovery controls delegate admission: ${outcome}`, async () => {
  const dir = scratch.create("dao-delegate-recovery");
  assert.deepEqual(await start(dir, "one", key, "none").done, { prepared: "one" });
  const file = join(dir, ".owner-intents", ".env.one.json");
  const records = JSON.parse(readFileSync(file, "utf8"));
  records.one.stage = "submitted";
  if (outcome === "payout") Object.assign(records.one, { type: "approval_vote", releases: "payout" });
  writeFileSync(file, JSON.stringify(records));
  assert.match((await start(dir, "two", key, "none").done).refused ?? "", /unresolved/);
  const recovered = await start(dir, "one", key, `recover-${outcome}`).done;
  assert.ok(recovered.recovered);
  const peer = saved(dir, "one").record;
  if (outcome === "unknown") {
    assert.equal(peer.stage, "submitted");
    assert.match((await start(dir, "two", key, "none", 42).done).refused ?? "", /unresolved/);
  } else {
    assert.equal(peer.stage, outcome === "payout" ? "submitted" : "settled");
    if (outcome !== "failed") assert.equal(peer.ownerSucceeded, true);
    assert.deepEqual(await start(dir, "two", key, "none", outcome === "failed" ? 41 : 42).done, { prepared: "two" });
    assert.equal(saved(dir, "two").action.nonce, outcome === "failed" ? 42n : 43n);
  }
});

test("a later instance refuses once the first owner's delegate is durably prepared", async () => {
  const dir = scratch.create("dao-delegate-serial");
  assert.deepEqual(await start(dir, "one", key, "none").done, { prepared: "one" });
  const second = await start(dir, "two", key, "none").done;
  assert.match(second.refused ?? "", /Another owner action.*waiting/);
  assert.equal(existsSync(join(dir, "two.checked")), false, "refused before nonce construction");
});

test("another owner key can prepare independently of the first owner's pending delegate", async () => {
  const dir = scratch.create("dao-delegate-other-owner");
  assert.deepEqual(await start(dir, "one", key, "none").done, { prepared: "one" });
  assert.deepEqual(await start(dir, "two", generateKey().publicKey.toString(), "none").done, { prepared: "two" });
  assert.notEqual(saved(dir, "one").action.senderId, saved(dir, "two").action.senderId);
});

for (const chainNonce of [41, 42]) test(`unresolved submitted peer blocks new preparation (observed chain nonce ${chainNonce})`, async () => {
  const dir = scratch.create("dao-delegate-submitted");
  assert.deepEqual(await start(dir, "one", key, "none").done, { prepared: "one" });
  const file = join(dir, ".owner-intents", ".env.one.json");
  const first = JSON.parse(readFileSync(file, "utf8"));
  // Representative durable state after a submission attempt, without a proven outcome.
  // No real owner signature or provider submission occurs in this fixture.
  first.one.stage = "submitted";
  writeFileSync(file, JSON.stringify(first));
  const before = readFileSync(file, "utf8");
  const second = await start(dir, "two", key, "none", chainNonce).done;
  assert.match(second.refused ?? "", /Another owner action.*unresolved/);
  assert.equal(readFileSync(file, "utf8"), before, "preparation does not reconcile the peer's submission");
  assert.equal(saved(dir, "one").action.nonce, 42n);
  assert.equal(existsSync(join(dir, "two.checked")), false);
});

// Remove state only after this suite has released its locks and stopped its processes.
after(scratch.cleanup);
