import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateKey, parseKey } from "near-kit";
import { fundingContextFixture } from "./fixtures/funding-context.js";
import { freshDirectory, TSX } from "./fixtures/harness.js";
import { ASSETS } from "../src/policy.js";
import { briefDigest, OPEN_ACCOUNT_WNEAR } from "../src/market/x402.js";

freshDirectory("market-funding-cli");
const script = fileURLToPath(new URL("../scripts/market-funding-proof.ts", import.meta.url));
const secret = generateKey().secretKey;
const account = Buffer.from(parseKey(secret).publicKey.data).toString("hex");
const brief = "Bounded funding observation; no hire";
const review = () => ({ ...fundingContextFixture(secret), actor: "owner:fixture", requestId: "proof-1", brief,
  approved: { handle: "funding-proof", brief: briefDigest(brief), network: "near:mainnet",
    asset: ASSETS.USDC.slice(7), payTo: "market.near", amount: "10000", maxTimeoutSeconds: 600 },
  agentId: process.env.AGENT_ID!, paymentAccount: account, providerOrigin: "https://api.demo.agentsonintents.com",
  approvalExpiresAt: Date.now() + 60_000, maxUsdc: "10000", maxOpeningWnear: OPEN_ACCOUNT_WNEAR });
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(TSX, [script, ...args], {
  cwd: process.cwd(), env: { ...process.env, ENV_FILE: existsSync(".env") ? realpathSync(".env") : "", MARKET_PAYMENT_KEY: secret,
    NEAR_INTENTS_AGENT_API_URL: "https://api.demo.agentsonintents.com", ...env }, encoding: "utf8", timeout: 15_000,
});

test("the funding CLI requires an explicit execute flag before reading a review", () => {
  const result = run(["missing-review.json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

for (const condition of ["over cap", "changed account", "changed provider", "expired", "approve only"] as const)
  test(`the funding CLI refuses ${condition} before any provider call`, () => {
    const input = review();
    if (condition === "over cap") input.maxUsdc = input.approved.amount = "10001";
    if (condition === "changed account") input.paymentAccount = "b".repeat(64);
    if (condition === "changed provider") input.providerOrigin = "https://example.invalid";
    if (condition === "expired") input.approvalExpiresAt = Date.now() - 1;
    writeFileSync("review.json", JSON.stringify(input), { mode: 0o600 });
    const result = run(["review.json", "--execute"], condition === "approve only" ? { EXECUTOR: "off" } : {});
    assert.notEqual(result.status, 0);
    const expected = condition === "over cap" ? /at most 10000/ : condition === "changed provider" ? /Provider origin/
      : condition === "expired" ? /Approval deadline/ : /Executor, agent or isolated/;
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /offline network|fetch failed/);
  });


test("the funding CLI refuses another working directory without hiding an unresolved canonical operation", async () => {
  const input = review();
  const { stateDirectory } = input;
  const { record, claimSubmission, readOps, opsLog } = await import("../src/ops.js");
  const request = { asset: ASSETS.wNEAR, amount: "1", chain: "near", recipient: "fixture.near", confidential: true };
  record({ idempotencyKey: "review:unknown", at: new Date().toISOString(), kind: "payout", method: "withdraw", journalVersion: 2, request });
  claimSubmission("review:unknown", request);
  assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
  const original = readFileSync(opsLog(), "utf8");
  const wrong = `${stateDirectory}/wrong-state`;
  mkdirSync(wrong);
  writeFileSync("review.json", JSON.stringify(input), { mode: 0o600 });
  const result = spawnSync(TSX, [script, `${stateDirectory}/review.json`, "--execute"], {
    cwd: wrong, env: { ...process.env, ENV_FILE: input.settingsFile, MARKET_PAYMENT_KEY: secret },
    encoding: "utf8", timeout: 15_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical working directory/);
  assert.equal(existsSync(`${wrong}/.ops`), false);
  assert.equal(readFileSync(opsLog(), "utf8"), original);
});

for (const condition of ["missing registry", "DAO registry", "mismatched owner"] as const)
  test(`funding context refuses ${condition} instead of trusting the CLI's absent owner-kind environment`, () => {
    const input = review();
    const registry = `${input.stateDirectory}/.hosted/apps.json`;
    if (condition === "missing registry") unlinkSync(registry);
    if (condition === "DAO registry") {
      const value = JSON.parse(readFileSync(registry, "utf8"));
      value.entries[0].kind = "dao";
      writeFileSync(registry, JSON.stringify(value));
    }
    if (condition === "mismatched owner") input.ownerAccount = "other.near";
    writeFileSync("review.json", JSON.stringify(input), { mode: 0o600 });
    const result = run(["review.json", "--execute"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable wallet-owner reservation/);
    assert.doesNotMatch(result.stderr, /offline network|fetch failed/);
    assert.equal(existsSync(`${input.stateDirectory}/.ops/${input.agentId}.jsonl`), false);
  });


for (const condition of ["missing state directory", "missing ops directory", "symlinked ops directory", "dangling journal symlink"] as const)
  test(`funding bootstrap refuses ${condition} without creating a replacement journal`, () => {
    const input = review();
    if (condition === "missing state directory") input.stateDirectory = `${input.stateDirectory}/not-created`;
    else if (condition === "missing ops directory") rmdirSync(`${input.stateDirectory}/.ops`);
    else if (condition === "dangling journal symlink") {
      symlinkSync(`${input.stateDirectory}/missing-journal`, `${input.stateDirectory}/.ops/${input.agentId}.jsonl`);
    } else {
      renameSync(`${input.stateDirectory}/.ops`, `${input.stateDirectory}/other-ops`);
      symlinkSync(`${input.stateDirectory}/other-ops`, `${input.stateDirectory}/.ops`);
    }
    writeFileSync("review.json", JSON.stringify(input), { mode: 0o600 });
    const result = run(["review.json", "--execute"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT|existing canonical directories|canonical regular file/);
    assert.doesNotMatch(result.stderr, /offline network|fetch failed/);
    assert.equal(existsSync(`${process.cwd()}/.ops/${input.agentId}.jsonl`), false);
  });
