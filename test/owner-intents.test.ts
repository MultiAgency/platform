import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { completeSigning, signingRequest } from "../src/dao-owner.js";
import { temporaryDirectories, TSX } from "./fixtures/harness.js";
import { preparedForWallet } from "./fixtures/wallet-signature.js";

const scratch = temporaryDirectories();

const FIXTURE = fileURLToPath(new URL("./fixtures/owner-intents.ts", import.meta.url));
// A grant the Agent API generated on mainnet, and the hash the DAO's MPC key signed for it.
const VECTOR = JSON.parse(readFileSync(new URL("./fixtures/owner-vector.json", import.meta.url), "utf8"));

const owner = { type: "near" as const, account_id: "a".repeat(64), public_key: "ed25519:11111111111111111111111111111111" };
const intent = { standard: "nep413", payload: { message: VECTOR.message, nonce: VECTOR.nonce, recipient: VECTOR.recipient } } as never;

test("the DAO signs the same hash the Agent API's request was signed with on mainnet", async () => {
  assert.equal((await signingRequest(intent, owner)).hash, VECTOR.hash);
});

test("the DAO's signature completes the signed data in either standard", async () => {
  const signature = Buffer.alloc(64, 7);
  const message = completeSigning(await signingRequest(intent, owner), signature) as { signature: string; public_key: string };
  assert.equal(message.signature, signature.toString("base64"));
  assert.equal(message.public_key, owner.public_key);

  // A delegate action's last 64 bytes are the signature placeholder; everything before stays as built.
  const built = Buffer.alloc(100, 1);
  const delegate = { owner, intent, hash: "00", delegate: built.toString("base64") };
  const signed = Buffer.from((completeSigning(delegate, signature) as { signed_delegate: string }).signed_delegate, "base64");
  assert.deepEqual(signed.subarray(0, 36), built.subarray(0, 36));
  assert.deepEqual(signed.subarray(36), signature);
});

test("a restarted server still follows a DAO vote in progress, and drops intents whose window closed", async () => {
  const dir = scratch.create("owner-intents");
  const file = join(dir, ".owner-intents", ".env.json");
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const dao = await signingRequest(intent, owner);
  mkdirSync(join(dir, ".owner-intents"));
  writeFileSync(
    file,
    JSON.stringify({
      voting: { type: "grant_issue", expiresAt: at(5), grantToken: "ngt_test", dao },
      closed: { type: "agent_freeze", expiresAt: at(-1), dao },
      unsigned: { type: "agent_freeze", expiresAt: at(-1) },
    }),
  );

  const result = spawnSync(TSX, [FIXTURE, "voting", "closed", "unsigned"], { cwd: dir, env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  // A wallet intent dropped at load is known expired in that process; after a later restart only a DAO's archive says so.
  assert.deepEqual(JSON.parse(result.stdout), ["voting", "expired", "expired"]);
  // Only the live intent is kept, its grant token and signing data intact, in a file only the owner reads.
  const kept = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(kept), ["voting"]);
  assert.deepEqual(kept.voting.dao, JSON.parse(JSON.stringify(dao)));
  assert.equal(kept.voting.grantToken, "ngt_test");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // A second restart still answers the expired DAO intent from its archive, as `daoRequests` does.
  const again = spawnSync(TSX, [FIXTURE, "closed"], { cwd: dir, env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 15_000 });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), ["expired"]);
});

test("a restarted server keeps a grant token only while its grant is still waiting to be issued", async () => {
  const dir = scratch.create("owner-intents");
  const file = join(dir, ".owner-intents", ".env.json");
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const dao = await signingRequest(intent, owner);
  mkdirSync(join(dir, ".owner-intents"));
  writeFileSync(
    file,
    JSON.stringify({
      waiting: { type: "grant_issue", expiresAt: at(5), grantToken: "ngt_waiting", dao },
      promoted: { type: "grant_issue", expiresAt: at(5), grantToken: "ngt_promoted", ownerSucceeded: true, stage: "submitted", dao },
      settled: { type: "grant_issue", expiresAt: at(-60), grantToken: "ngt_settled", stage: "settled", result: { status: "SUCCESS" }, dao },
    }),
  );
  const result = spawnSync(TSX, [FIXTURE, "waiting"], { cwd: dir, env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const kept = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(kept.waiting.grantToken, "ngt_waiting");
  assert.equal(kept.promoted.grantToken, undefined);
  assert.equal(kept.settled.grantToken, undefined);
  assert.doesNotMatch(readFileSync(file, "utf8"), /ngt_promoted|ngt_settled/);
});

const SUBMIT = fileURLToPath(new URL("./fixtures/submit.ts", import.meta.url));

/** A directory where a grant was prepared, its token not yet in use, and the pending file it needs. */
function preparedGrant() {
  const dir = scratch.create("owner-submit");
  mkdirSync(join(dir, ".owner-intents"));
  const grant = { type: "grant_issue", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), grantToken: "ngt_new", wallet: preparedForWallet };
  writeFileSync(join(dir, ".owner-intents", ".env.json"), JSON.stringify({ grant }));
  writeFileSync(join(dir, ".env"), "AGENT_GRANT_TOKEN=ngt_old\n");
  return dir;
}

function submitIn(dir: string, answer: "lost" | "refused" | "accepted" | "recover" | "timeout" | "uncertain" | "unreached" | "late" | "forged") {
  const creating = JSON.parse(readFileSync(join(dir, ".owner-intents", ".env.json"), "utf8")).grant.type === "agent_create";
  const result = spawnSync(TSX, [SUBMIT, answer], { cwd: dir, env: { ...process.env, ENV_FILE: "", ...(creating && { AGENT_ID: "" }) }, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const pending = Object.keys(JSON.parse(readFileSync(join(dir, ".owner-intents", ".env.json"), "utf8")));
  return { outcome: JSON.parse(result.stdout), pending, env: readFileSync(join(dir, ".env"), "utf8") };
}

test("a lost submission is recovered after restart by polling, without resubmitting", () => {
  const dir = preparedGrant();
  const lost = submitIn(dir, "lost");
  assert.match(lost.outcome.error, /fetch failed/);
  assert.equal(lost.outcome.sends, 1);
  assert.deepEqual(lost.pending, ["grant"]);
  assert.match(lost.env, /AGENT_GRANT_TOKEN_PENDING=ngt_new/);
  const accepted = submitIn(dir, "accepted");
  assert.deepEqual(accepted.outcome, { result: { status: "SUCCESS" }, sends: 0 });
  assert.deepEqual(accepted.pending, ["grant"]);
  assert.match(accepted.env, /AGENT_GRANT_TOKEN=ngt_new/);
  assert.deepEqual(submitIn(dir, "accepted").outcome, accepted.outcome);
});

test("a wallet signature that isn't the owner's over the prepared intent never reaches the API", () => {
  const dir = preparedGrant();
  const forged = submitIn(dir, "forged");
  assert.match(forged.outcome.error, /Not submitted: the signature doesn't verify/);
  assert.equal(forged.outcome.sends, 0);
  // Still waiting for a real signature, and the new grant's token not staged.
  assert.doesNotMatch(forged.env, /ngt_new/);
  assert.deepEqual(submitIn(dir, "accepted").outcome, { result: { status: "SUCCESS" }, sends: 1 });
});

test("a rejected submission stays poll-only rather than assuming safe replay", () => {
  const dir = preparedGrant();
  const refused = submitIn(dir, "refused");
  assert.ok(refused.outcome.error);
  assert.equal(refused.outcome.sends, 1);
  assert.deepEqual(refused.pending, ["grant"]);
  assert.equal(submitIn(dir, "accepted").outcome.sends, 0);
});

test("accepted intent survives status failure and expiry and settles on restart", () => {
  const dir = preparedGrant();
  assert.match(submitIn(dir, "timeout").outcome.error, /timeout/);
  const file = join(dir, ".owner-intents", ".env.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.grant.stage, "submitted");
  saved.grant.expiresAt = new Date(0).toISOString();
  writeFileSync(file, JSON.stringify(saved));
  const recovered = submitIn(dir, "recover");
  assert.equal(recovered.outcome.sends, 0);
  assert.equal(recovered.outcome.result[0].status, "SUCCESS");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).grant.stage, "settled");
});

test("uncertain owner outcome remains submitted without promoting the grant", () => {
  const dir = preparedGrant();
  const result = submitIn(dir, "uncertain");
  assert.equal(result.outcome.result.status, "UNCERTAIN");
  assert.match(result.env, /^AGENT_GRANT_TOKEN=ngt_old$/m);
  assert.equal(submitIn(dir, "uncertain").outcome.sends, 0);
});

test("restart recovers agent creation and an approval's released operation", () => {
  for (const type of ["agent_create", "approval_vote"]) {
    const dir = preparedGrant();
    const file = join(dir, ".owner-intents", ".env.json");
    writeFileSync(file, JSON.stringify({ grant: {
      stage: "submitted", type, expiresAt: new Date(0).toISOString(),
      ...(type === "approval_vote" && { releases: "held-action", ownerSucceeded: true }),
    } }));
    if (type === "approval_vote") {
      mkdirSync(join(dir, ".ops"));
      writeFileSync(join(dir, ".ops", "a".repeat(64) + ".jsonl"),
        JSON.stringify({ at: new Date().toISOString(), idempotencyKey: "held", kind: "payout",
          method: "transfer", request: { asset: "usdc", amount: "1" }, correlation_id: "held-action", status: "PENDING_APPROVAL" }) + "\n");
    }
    const result = submitIn(dir, "recover");
    assert.equal(result.outcome.sends, 0);
    assert.equal(result.outcome.result[0].status, "SUCCESS");
    if (type === "agent_create") assert.match(result.env, /AGENT_ID=recovered-agent/);
    else assert.match(readFileSync(join(dir, ".ops", "a".repeat(64) + ".jsonl"), "utf8"), /SUCCESS/);
  }
});

test("a submission the API never received is sent again while the window is open, and settles", () => {
  const dir = preparedGrant();
  const unreached = submitIn(dir, "unreached");
  assert.match(unreached.outcome.error, /fetch failed/);
  assert.equal(unreached.outcome.sends, 1);
  // The API still awaits the signature: resubmitting the same one is safe, and saves the DAO's vote.
  const late = submitIn(dir, "late");
  assert.equal(late.outcome.sends, 1);
  assert.equal(late.outcome.result[0].status, "SUCCESS");
  assert.match(late.env, /AGENT_GRANT_TOKEN=ngt_new/);
});

test("once the window closes, a submission the API never received ends as expired instead of polling forever", () => {
  const dir = preparedGrant();
  submitIn(dir, "unreached");
  const file = join(dir, ".owner-intents", ".env.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.grant.expiresAt = new Date(0).toISOString();
  writeFileSync(file, JSON.stringify(saved));
  const closed = submitIn(dir, "late");
  assert.equal(closed.outcome.sends, 0);
  assert.equal(closed.outcome.result[0].status, "EXPIRED");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).grant.stage, "settled");
  assert.match(closed.env, /^AGENT_GRANT_TOKEN=ngt_old$/m);
});

// Remove state only after this suite has released its locks and stopped its processes.
after(scratch.cleanup);
