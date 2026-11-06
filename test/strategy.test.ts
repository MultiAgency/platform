import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ASSETS } from "../src/policy.js";
import { loadStrategy, saveStrategy, STRATEGY_FILE } from "../src/strategy.js";
import { DEFAULT_STRATEGY, grantApproves, type Strategy, strategyDigest, strategyLabelSuffix } from "../src/strategy-digest.js";
import { freshDirectory } from "./fixtures/harness.js";

// Every test gets an empty directory: the strategy file is read from the working directory.
freshDirectory("strategy");

const save = (strategy: unknown) => {
  mkdirSync(".strategy", { recursive: true });
  writeFileSync(STRATEGY_FILE, JSON.stringify(strategy));
};

// Pinned: any other implementation of the canonical form must reproduce this digest.
test("without a file, today's constants apply, under a fixed digest", () => {
  assert.deepEqual(loadStrategy(), DEFAULT_STRATEGY);
  assert.equal(strategyDigest(DEFAULT_STRATEGY), "sha256:bc37ba018a92e973c6a8cc134bfffd6088918f4ff9fac194d478c781b6e8a459");
});

test("the owner's file replaces the defaults; key order doesn't change the digest", () => {
  const owner: Strategy = { ...DEFAULT_STRATEGY, autopilot: { everyMin: 30, maxUsd: 5 } };
  save({ autopilot: owner.autopilot, maxCostBps: owner.maxCostBps, minLegUsd: owner.minLegUsd, targetBps: { ...owner.targetBps } });
  assert.deepEqual(loadStrategy(), owner);
  assert.equal(strategyDigest(loadStrategy()), strategyDigest(owner));
  assert.notEqual(strategyDigest(owner), strategyDigest(DEFAULT_STRATEGY));
});

test("a file that isn't a whole, consistent strategy is refused, never half-applied", () => {
  const cases: [string, unknown, RegExp][] = [
    ["targets off 10 000", { ...DEFAULT_STRATEGY, targetBps: { ...DEFAULT_STRATEGY.targetBps, [ASSETS.ETH]: 2_000 } }, /10 000/],
    ["an asset missing", { ...DEFAULT_STRATEGY, targetBps: { [ASSETS.USDC]: 5_000, [ASSETS.wNEAR]: 5_000 } }, /targetBps/],
    ["an asset outside the treasury", { ...DEFAULT_STRATEGY, targetBps: { ...DEFAULT_STRATEGY.targetBps, "nep141:usdt.tether-token.near": 0 } }, /targetBps/],
    ["a fraction", { ...DEFAULT_STRATEGY, autopilot: { everyMin: 60, maxUsd: 2.5 } }, /maxUsd/],
    ["runs too often", { ...DEFAULT_STRATEGY, autopilot: { everyMin: 1, maxUsd: 0 } }, /everyMin/],
    ["no ceiling", { ...DEFAULT_STRATEGY, autopilot: { everyMin: 60 } }, /maxUsd/],
  ];
  for (const [name, strategy, expected] of cases) {
    save(strategy);
    assert.throws(() => loadStrategy(), expected, name);
  }
});

// Pinned before the cash floor existed: a strategy without one keeps its digest, so its grants stay valid.
test("a saved strategy without a cash floor keeps the digest and grant suffix it had before the floor existed", () => {
  save({ targetBps: { [ASSETS.USDC]: 6_000, [ASSETS.wNEAR]: 3_000, [ASSETS.ETH]: 1_000 }, minLegUsd: 5, maxCostBps: 100, autopilot: { everyMin: 30, maxUsd: 25 } });
  const loaded = loadStrategy();
  assert.equal("cashFloor" in loaded, false, "leaving it out means no floor, never a default one");
  assert.equal(strategyDigest(loaded), "sha256:978b7029378efb1f681227e127def466afd77f6f9a5e10c185d58e4507be9265");
  assert.equal(strategyLabelSuffix(loaded), "978b7029378efb1f681227e127def466");
  saveStrategy(loaded);
  assert.equal(strategyDigest(loadStrategy()), "sha256:978b7029378efb1f681227e127def466afd77f6f9a5e10c185d58e4507be9265");
});

test("a cash floor is bound by the digest, saved with its assets sorted, and refused when malformed", () => {
  const sorted = [ASSETS.USDC, ASSETS.wNEAR].sort();
  saveStrategy({ ...DEFAULT_STRATEGY, cashFloor: { usd: 500, assets: [...sorted].reverse() } } as Strategy);
  const loaded = loadStrategy();
  assert.deepEqual(loaded.cashFloor, { usd: 500, assets: sorted });
  assert.equal(strategyDigest(loaded), strategyDigest({ ...DEFAULT_STRATEGY, cashFloor: { usd: 500, assets: sorted } } as Strategy));
  assert.notEqual(strategyDigest(loaded), strategyDigest(DEFAULT_STRATEGY));
  assert.ok(!grantApproves(`treasury:${strategyLabelSuffix(DEFAULT_STRATEGY)}`, loaded), "a grant for the strategy without the floor doesn't approve it");
  assert.notEqual(strategyDigest({ ...loaded, cashFloor: { usd: 501, assets: sorted } } as Strategy), strategyDigest(loaded));
  const cases: [string, unknown][] = [
    ["a fraction", { usd: 2.5, assets: [ASSETS.USDC] }], ["zero", { usd: 0, assets: [ASSETS.USDC] }],
    ["no assets", { usd: 10, assets: [] }], ["a repeated asset", { usd: 10, assets: [ASSETS.USDC, ASSETS.USDC] }],
    ["an asset outside the treasury", { usd: 10, assets: ["nep141:usdt.tether-token.near"] }], ["no amount", { assets: [ASSETS.USDC] }],
  ];
  for (const [name, cashFloor] of cases) {
    save({ ...DEFAULT_STRATEGY, cashFloor });
    assert.throws(() => loadStrategy(), /cashFloor/, name);
  }
});

test("a grant approves the strategy whose digest its label carries, and no other", () => {
  const suffix = strategyLabelSuffix(DEFAULT_STRATEGY);
  assert.match(suffix, /^[0-9a-f]{32}$/);
  assert.equal(strategyDigest(DEFAULT_STRATEGY).slice(7, 39), suffix);
  const label = `treasury:${suffix}`;
  assert.ok(label.length <= 64, "fits the API's 64-character label");
  assert.ok(grantApproves(label, DEFAULT_STRATEGY));
  assert.ok(!grantApproves("treasury", DEFAULT_STRATEGY));
  assert.ok(!grantApproves(label, { ...DEFAULT_STRATEGY, autopilot: { everyMin: 60, maxUsd: 1_000 } }));
});

test("a saved strategy is what loads next, and an inconsistent one is never written", () => {
  const owner: Strategy = { ...DEFAULT_STRATEGY, autopilot: { everyMin: 15, maxUsd: 3 } };
  saveStrategy(owner);
  assert.deepEqual(loadStrategy(), owner);
  assert.throws(() => saveStrategy({ ...owner, minLegUsd: 0 }));
  assert.deepEqual(loadStrategy(), owner);
});

test("a treasury grant carries the strategy in force, so the owner's signature approves it", async () => {
  const { grantRequest } = await import("../src/grants.js");
  saveStrategy({ ...DEFAULT_STRATEGY, autopilot: { everyMin: 60, maxUsd: 3 } });
  const treasury = (await grantRequest({ label: "treasury" })).request.label;
  assert.equal(treasury, `treasury:${strategyLabelSuffix(loadStrategy())}`);
  assert.ok(grantApproves(treasury, loadStrategy()));
  // Other grants don't run the strategy; a suffix named explicitly is kept as given.
  assert.equal((await grantRequest({ label: "payout" })).request.label, "payout");
  assert.equal((await grantRequest({ label: "treasury", suffix: "x" })).request.label, "treasury:x");
});
