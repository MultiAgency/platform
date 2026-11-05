import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { authorityFixture, balanceView, marketTokens, policyView, quoteAt, timedPrices, wholeTokens } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { executePlan, feasibility, observe, savePlan, type PlannedAction } from "../src/plans.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { loadStrategy, saveStrategy } from "../src/strategy.js";
import { opsLog, readOps } from "../src/ops.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

const a = ASSETS.USDC, b = ASSETS.wNEAR;
let tokens: ReturnType<typeof wholeTokens>;
let book: Record<string, { public: bigint; confidential: bigint }>;
let revision: number;
let sends: string[];
let afterSend: () => void;
let time: number;
freshDirectory("plan-recovery");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  book = Object.fromEntries(Object.values(ASSETS).map((asset) => [asset, { public: 10n, confidential: 10n }]));
  tokens = wholeTokens();
  revision = 1; sends = []; afterSend = () => {}; time = Date.now();
  offline();
  const authority = authorityFixture("treasury");
  mock.method(api, "getAgent", authority.getAgent);
  mock.method(api, "getWallet", authority.getWallet);
  mock.method(api, "getHistory", authority.getHistory);
  mock.method(api, "listGrants", authority.listGrants);
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy, revision));
  mock.method(api, "getTokens", async () => timedPrices(tokens, time));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) =>
    balanceView(source, Object.entries(book).map(([asset_id, balances]) => ({ asset_id, balance_raw: String(balances[source]) }))));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  mock.method(api, "forGrant", () => ({
    shield: async (_id: string, request: { asset: string; amount: string }) => {
      sends.push("shield");
      book[request.asset]!.public -= BigInt(request.amount);
      book[request.asset]!.confidential += BigInt(request.amount);
      afterSend();
      return { correlation_id: String(sends.length) };
    },
    swap: async (_id: string, request: { dry?: boolean; origin_asset: string; destination_asset: string; amount: string }) => {
      if (request.dry) return { quote: quoteAt(tokens, request) };
      sends.push("swap");
      book[request.origin_asset]!.confidential -= BigInt(request.amount);
      book[request.destination_asset]!.confidential += BigInt(quoteAt(tokens, request).amount_out);
      afterSend();
      return { correlation_id: String(sends.length) };
    },
  }));
});
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
const swap = (amount = "15"): PlannedAction => ({ type: "swap", from: a, to: b, amount, amountOut: amount, minAmountOut: amount, costBps: 0 });
const run = async (actions: PlannedAction[]) => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "offline test", actions, new Date(time));
  const events = [];
  for await (const event of executePlan(plan.id, () => new Date(time))) events.push(event);
  return events;
};

test("cumulative swaps reject before any send", async () => {
  assert.equal((await run([swap(), swap()]))[0]?.type, "rejected");
  assert.deepEqual(sends, []);
  assert.deepEqual(readOps(), []);
});
test("a swap's automatic shield cannot fund a later explicit shield twice", async () => {
  assert.equal((await run([swap(), { type: "shield", asset: a, amount: "10" }]))[0]?.type, "rejected");
  assert.deepEqual(sends, []);
});
test("ordered shields and dependent swaps use guaranteed floors", () => {
  const balances = { [a]: { public: "10", confidential: "0" }, [b]: { public: "0", confidential: "0" } };
  const back: PlannedAction = { ...swap("10") as Extract<PlannedAction, { type: "swap" }>, from: b, to: a };
  assert.deepEqual(feasibility([{ type: "shield", asset: a, amount: "10" }, swap("10"), back], balances), []);
  assert.match(feasibility([swap("10"), { ...back, amount: "11" }], balances).join(), /remaining balance/);
});
for (const change of ["policy", "strategy", "expiry"]) {
  test(change + " change after an automatic shield prevents its swap", async () => {
    afterSend = () => {
      if (change === "policy") revision++;
      if (change === "strategy") saveStrategy({ ...loadStrategy(), maxCostBps: loadStrategy().maxCostBps + 1 });
      if (change === "expiry") time += 600_000;
    };
    const events = await run([swap()]);
    assert.deepEqual(sends, ["shield"]);
    assert.equal(events.at(-1)?.type, "rejected");
    // The refused swap is logged with the reason, resolved, so it blocks nothing.
    const code = { policy: "plan_policy_changed", strategy: "strategy_changed", expiry: "plan_expired" }[change];
    assert.deepEqual(readOps().map((op) => op.refused), [undefined, code]);
  });
}
test("policy change after the first leg stops the second leg", async () => {
  afterSend = () => revision++;
  const events = await run([{ type: "shield", asset: a, amount: "1" }, { type: "shield", asset: b, amount: "1" }]);
  assert.deepEqual(sends, ["shield"]);
  assert.equal(events.at(-1)?.type, "rejected");
});
test("a feasible sequence executes once and updates the book between actions", async () => {
  const events = await run([{ type: "shield", asset: a, amount: "5" }, swap()]);
  assert.deepEqual(sends, ["shield", "swap"]);
  assert.equal(events.length, 2);
});

/** Market prices with real decimals: 10 of each token, public and confidential, in raw units. */
const atMarket = () => {
  tokens = marketTokens();
  for (const token of tokens) book[token.asset_id] = { public: 10n * 10n ** BigInt(token.decimals), confidential: 10n * 10n ** BigInt(token.decimals) };
};
/** 15 USDC into wNEAR at the listed prices, its floor `floorBps` below the quote. */
const marketSwap = (floorBps = 0): PlannedAction => {
  const amount = "15000000", { amount_out } = quoteAt(tokens, { origin_asset: a, destination_asset: b, amount });
  return { type: "swap", from: a, to: b, amount, amountOut: amount_out, minAmountOut: (BigInt(amount_out) * BigInt(10_000 - floorBps) / 10_000n).toString(), costBps: 0 };
};
test("at market prices and real decimals, a feasible sequence executes once and updates the book between actions", async () => {
  atMarket();
  const events = await run([{ type: "shield", asset: a, amount: "5000000" }, marketSwap()]);
  assert.deepEqual(sends, ["shield", "swap"]);
  assert.equal(events.length, 2);
  // 15 USDC at 0.9997/2.37 wNEAR per USDC, rounded down in raw units.
  assert.equal(book[b]!.confidential, 10n * 10n ** 24n + 6_327215189873417721518987n);
});
test("at market prices, the output floor is held to the strategy's cost ceiling in fractional USD", async () => {
  atMarket();
  const ceiling = loadStrategy().maxCostBps;
  assert.equal((await run([marketSwap(ceiling + 50)])).at(-1)?.type, "rejected", "a floor past the ceiling stops before shielding");
  assert.deepEqual(sends, []);
  assert.deepEqual(readOps().map((op) => op.refused), ["swap_cost_exceeded"]);
  const events = await run([marketSwap(ceiling - 50)]);
  assert.deepEqual(sends, ["shield", "swap"], "a floor inside the ceiling executes");
  assert.equal(events.at(-1)?.type, "action");
});

test("policy drift during asynchronous send preflight produces zero sends", async () => {
  let reads = 0;
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy, ++reads >= 4 ? 2 : 1));
  // Preview, execution snapshot and leg observation see revision 1; dispatch sees revision 2.
  const events = await run([{ type: "shield", asset: a, amount: "1" }]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.deepEqual(sends, []);
  assert.deepEqual(readOps().map((op) => op.refused), ["plan_policy_changed"]);
});

test("an output floor above the strategy's cost ceiling stops before shielding", async () => {
  const action = { ...swap(), minAmountOut: "10" } as PlannedAction;
  const events = await run([action]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.deepEqual(sends, []);
});

test("a shield that becomes uncertain prevents the swap and subsequent legs", async () => {
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "UNCERTAIN" }));
  const events = await run([swap(), { type: "shield", asset: b, amount: "1" }]);
  assert.deepEqual(sends, ["shield"]);
  assert.equal(events.at(-1)?.type, "action");
  assert.equal(readOps()[0]?.status, "UNCERTAIN");
});


test("submission observers run after the journal records acceptance and cannot stop outcome tracking", async () => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "offline test", [swap("5")], new Date(time));
  const observations: { method: string; recorded: boolean }[] = [];
  const events = [];
  for await (const event of executePlan(plan.id, () => new Date(time), { onSubmitted(method, correlationId) {
    observations.push({ method, recorded: readOps().some(op => op.correlationId === correlationId && op.status === "SENT") });
    throw new Error("supplementary display failed");
  } })) events.push(event);
  assert.deepEqual(observations, [{ method: "swap", recorded: true }]);
  assert.deepEqual(sends, ["swap"]);
  assert.ok(events.some(event => event.type === "action" && event.status === "SUCCESS"));
  assert.equal(readOps()[0]!.status, "SUCCESS");
});

test("a failed execution-marker directory sync sends nothing and leaves the plan claimed", async () => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "offline durability fault", [swap()], new Date(time));
  opsLog();
  const planDirectory = fs.statSync(".plans").ino;
  const sync = fs.fsyncSync;
  mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.fstatSync(fd).ino === planDirectory) throw new Error("directory sync failed");
    sync(fd);
  });
  syncBuiltinESMExports();
  const execute = async () => {
    const events = [];
    for await (const event of executePlan(plan.id, () => new Date(time))) events.push(event);
    return events;
  };
  await assert.rejects(execute(), /directory sync failed/);
  assert.deepEqual(sends, []);
  assert.deepEqual(await execute(), [{ type: "rejected", problems: ["the plan was already executed"] }]);
  assert.deepEqual(sends, []);
});


test("a failed journal-directory sync blocks repeated execution attempts before sending", async () => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "offline directory retry", [swap()], new Date(time));
  const stateParent = fs.statSync(process.cwd()).ino;
  const sync = fs.fsyncSync;
  let fail = true;
  mock.method(fs, "fsyncSync", (fd: number) => {
    if (fail && fs.fstatSync(fd).ino === stateParent) throw new Error("state parent sync failed");
    sync(fd);
  });
  syncBuiltinESMExports();
  const execute = async () => {
    const events = [];
    for await (const event of executePlan(plan.id, () => new Date(time))) events.push(event);
    return events;
  };
  await assert.rejects(execute(), /state parent sync failed/);
  await assert.rejects(execute(), /state parent sync failed/);
  assert.deepEqual(sends, []);
  fail = false;
  await execute();
  assert.deepEqual(sends, ["shield", "swap"]);
});
