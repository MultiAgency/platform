import { authorityFixture, balanceView, fixtureGrant, policyView, timedPrices } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { saveSettings, settings, status, tick } from "../src/autopilot.js";
import { exportRunLog } from "../src/run-log-export.js";
import { sourceDigest, ticks } from "../src/evidence.js";
import { dismiss, post, readInbox } from "../src/inbox.js";
import { prepareInvoice } from "../src/invoice-store.js";
import { blocksDispatch, readOps, opsLog } from "../src/ops.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { loadStrategy } from "../src/strategy.js";
import { strategyDigest, strategyLabelSuffix } from "../src/strategy-digest.js";
import { enableSchedule, saveReviewedStrategy } from "../src/strategy-controls.js";
import { prepare, submit } from "../src/owner-intents.js";
import { walletIntent, walletSignature, walletSigner } from "./fixtures/wallet-signature.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

// Offline: an in-memory book behind the API, so each tick runs the real sweep, rebalance, plan
// checks, lock and ops log. Every asset has 0 decimals and a $1 price, and quotes cost nothing.
let book: Record<string, { public: bigint; confidential: bigint }>;
let frozen: boolean;
let sends: string[];
let statusOf: (id: string) => string;
/** The label of this server's live grant; by default one that approves the strategy in force. */
let grantLabel: () => string;

freshDirectory("autopilot");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  // 100 USDC and nothing else: 50 below target in wNEAR and ETH together.
  book = Object.fromEntries(Object.values(ASSETS).map((asset) => [asset, { public: 0n, confidential: 0n }]));
  book[ASSETS.USDC]!.confidential = 100n;
  frozen = false;
  sends = [];
  statusOf = () => "SUCCESS";
  grantLabel = () => `treasury:${strategyLabelSuffix(loadStrategy())}`;
  offline();
  const authority = authorityFixture("treasury");
  mock.method(api, "getAgent", authority.getAgent);
  mock.method(api, "getWallet", authority.getWallet);
  mock.method(api, "getHistory", authority.getHistory);
  mock.method(api, "getPolicy", async () => policyView({ ...treasuryPolicy, frozen, budget: { daily_usd: "1000", weekly_usd: "1000", monthly_usd: "1000" } }, 1));
  mock.method(api, "getTokens", async () => timedPrices(Object.entries(ASSETS).map(([symbol, asset_id]) => ({ symbol, asset_id, decimals: 0, price: 1 }))));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) => balanceView(source,
    Object.entries(book).map(([asset_id, balances]) => ({ asset_id, balance_raw: String(balances[source]) }))));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: statusOf(correlation_id) }));
  mock.method(api, "listGrants", async () => [{ ...fixtureGrant(grantLabel()), grant_id: "g" }]);
  mock.method(api, "forGrant", () => ({
    shield: async (_id: string, request: { asset: string; amount: string }) => {
      sends.push(`shield ${request.asset}`);
      book[request.asset]!.public -= BigInt(request.amount);
      book[request.asset]!.confidential += BigInt(request.amount);
      return { correlation_id: `op_${sends.length}` };
    },
    swap: async (_id: string, request: { dry?: boolean; origin_asset: string; destination_asset: string; amount: string }) => {
      if (request.dry) return { quote: { amount_out: request.amount, min_amount_out: request.amount } };
      sends.push(`swap ${request.origin_asset} → ${request.destination_asset}`);
      book[request.origin_asset]!.confidential -= BigInt(request.amount);
      book[request.destination_asset]!.confidential += BigInt(request.amount);
      return { correlation_id: `op_${sends.length}` };
    },
  }));
});
afterEach(() => mock.restoreAll());

const limit = (maxUsd: number) => saveSettings({ ...settings(), maxUsd });
const open = () => readInbox().filter((e) => e.level !== "run" && !e.dismissed);

test("skipping every quote for cost does not claim the book is on target", async () => {
  mock.method(api, "forGrant", () => ({
    swap: async (_id: string, request: { dry?: boolean }) => {
      assert.equal(request.dry, true, "cost-rejected swaps must never send");
      return { quote: { amount_out: "1", min_amount_out: "1" } };
    },
  }));
  const report = await tick("schedule");
  assert.doesNotMatch(report, /book on target/);
  assert.match(report, /all proposed swaps exceed the cost limit/);
  assert.deepEqual(sends, []);
  assert.equal(ticks().ticks[0]?.end?.outcome, report);
});

test("a rebalance within the limit executes, and the tick says what it did", async () => {
  limit(100);
  const report = await tick("schedule");
  // Which deficit the planner fills first is its business; both must be filled.
  assert.deepEqual(sends.toSorted(), [`swap ${ASSETS.USDC} → ${ASSETS.ETH}`, `swap ${ASSETS.USDC} → ${ASSETS.wNEAR}`]);
  assert.equal(book[ASSETS.USDC]!.confidential, 50n);
  assert.match(report, /step 1: SUCCESS, step 2: SUCCESS/);
  assert.equal(readInbox()[0]?.level, "run");
  assert.deepEqual(open(), []);
});

test("a rebalance above the limit sends nothing and asks the owner", async () => {
  limit(10);
  const report = await tick("schedule");
  assert.deepEqual(sends, []);
  assert.match(report, /rebalance of \$50\.00 left for the owner/);
  const [ask] = open();
  assert.equal(ask?.level, "action");
  assert.match(ask!.text, /\$50\.00 is above the \$10\.00 auto-execute limit/);
});

test("public balances are shielded even at a $0 limit, before the rebalance is weighed", async () => {
  book[ASSETS.wNEAR]!.public = 5n;
  limit(0);
  await tick("schedule");
  assert.deepEqual(sends, [`shield ${ASSETS.wNEAR}`]);
  assert.equal(book[ASSETS.wNEAR]!.public, 0n);
});

test("an action without a proven outcome stops the tick before anything is sent or resent", async () => {
  writeFileSync(
    opsLog(),
    `${JSON.stringify({ at: new Date().toISOString(), idempotencyKey: "swap:lost", kind: "rebalance", method: "swap", request: { origin_asset: "a", destination_asset: "b", amount: "1" } })}\n`,
  );
  limit(100);
  assert.equal(await tick("schedule"), "Skipped: unresolved money actions.");
  assert.deepEqual(sends, []);
  // Never sent, so its acceptance is unknown: recover() reports it and resends nothing.
  assert.match(open()[0]!.text, /swap:lost \(unknown, 0 min old\)/);
});

test("an invoice prepared but never submitted doesn't stop the tick, as it doesn't stop the money lock", async () => {
  prepareInvoice({ payee: "p.near", submission: "s", amount: "1", note: "" }, ASSETS.USDC);
  limit(100);
  assert.notEqual(await tick("schedule"), "Skipped: unresolved money actions.");
  assert.ok(sends.length > 0);
});

test("a legacy held payout without valuation evidence no longer holds new execution", async () => {
  writeFileSync(
    opsLog(),
    [
      { at: new Date().toISOString(), idempotencyKey: "payout:held", kind: "payout", method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "p.near", confidential: true } },
      { idempotencyKey: "payout:held", correlation_id: "op_held", status: "PENDING_APPROVAL" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  statusOf = (id) => (id === "op_held" ? "PENDING_APPROVAL" : "SUCCESS");
  limit(100);
  // It's reported, not reserved locally; the provider's own budget usage still counts it.
  assert.doesNotMatch(await tick("schedule"), /valuation evidence/);
});

test("a frozen agent is left alone", async () => {
  frozen = true;
  limit(100);
  assert.equal(await tick("schedule"), "Skipped: the agent is frozen.");
  assert.deepEqual(sends, []);
});

test("two ticks never run at once", async () => {
  limit(100);
  const [first, second] = await Promise.all([tick("schedule"), tick("schedule")]);
  assert.match(first, /step 1: SUCCESS/);
  assert.equal(second, "Skipped: a tick is already running.");
  assert.equal(sends.length, 2);
});

test("the limit lives in the strategy file and on/off in the settings file", () => {
  saveSettings({ on: true, everyMin: 15, maxUsd: 7 });
  assert.deepEqual(settings(), { on: true, everyMin: 15, maxUsd: 7 });
  assert.equal(process.env.AUTOPILOT, "on");
  saveSettings({ on: false, everyMin: 15, maxUsd: 7 });
  assert.equal(settings().on, false);
});

test("a dismissed entry stays in the inbox but no longer asks", async () => {
  limit(10);
  await tick("schedule");
  const [ask] = open();
  dismiss(ask!.id);
  assert.deepEqual(open(), []);
  assert.equal(readInbox().find((e) => e.id === ask!.id)?.dismissed, true);
});

test("a rebalance within the limit waits when the owner's grant doesn't approve the strategy in force", async () => {
  limit(100);
  // Signed for another strategy (the owner approved a different limit), or for none at all.
  for (const label of ["treasury:00000000000000000000000000000000", "treasury"]) {
    grantLabel = () => label;
    const report = await tick("schedule");
    assert.deepEqual(sends, []);
    assert.match(report, /left for the owner: the owner's grant doesn't approve this strategy/);
    const ask = open().at(-1);
    assert.equal(ask?.level, "action");
    assert.ok(ask!.text.includes(`treasury:${strategyLabelSuffix(loadStrategy())}`), "names the label a new grant must carry");
  }
});

test("without an approving strategy grant, public balances cannot bypass authority by shielding", async () => {
  book[ASSETS.wNEAR]!.public = 5n;
  limit(100);
  grantLabel = () => "treasury";
  await tick("schedule");
  assert.deepEqual(sends, []);
});

test("changing the limit stops auto-execution until the owner signs a grant for the new strategy", async () => {
  limit(100);
  const approved = `treasury:${strategyLabelSuffix(loadStrategy())}`;
  grantLabel = () => approved;
  limit(90); // any edit is another mandate, even a lower limit
  await tick("schedule");
  assert.deepEqual(sends, []);
  grantLabel = () => `treasury:${strategyLabelSuffix(loadStrategy())}`;
  assert.match(await tick("schedule"), /step 1: SUCCESS/);
});

for (const changeDuring of ["mandate", "sweep", "planning"] as const) test(`a strategy replaced during ${changeDuring} cannot borrow a running tick's old ceiling`, async () => {
  saveSettings({ ...settings(), on: true, maxUsd: 100 });
  let currentGrant = fixtureGrant(grantLabel());
  let grantReads = 0;
  let balanceReads = 0;
  let ownerSubmissions = 0;
  let requestedGrant: { label: string; credential: string } | undefined;
  mock.method(api, "generateIntent", async (request: { type: string; label: string; credential: string }) => {
    assert.equal(request.type, "grant_issue");
    requestedGrant = request;
    return { type: request.type, correlation_id: "replacement-grant", expires_at: new Date(Date.now() + 600_000).toISOString(),
      preview: {}, intent: walletIntent, signer: walletSigner };
  });
  mock.method(api, "submitIntent", async () => {
    ownerSubmissions++;
    assert.ok(requestedGrant);
    const grant = fixtureGrant(requestedGrant.label);
    currentGrant = { ...grant, owner_message: { ...grant.owner_message, credential: requestedGrant.credential } };
    return { status: "SUCCESS" };
  });
  const replaceStrategy = async () => {
    const before = loadStrategy();
    const saved = await saveReviewedStrategy({ ...before, autopilot: { ...before.autopilot, maxUsd: 1 } }, strategyDigest(before));
    const prepared = await prepare({ type: "grant_issue", label: "treasury", expectedStrategyDigest: saved.digest });
    await submit(prepared.correlationId, await walletSignature());
    await enableSchedule(saved.digest);
  };
  mock.method(api, "listGrants", async () => {
    // The first read records the tick's starting evidence; the second checks its mandate.
    if (++grantReads === 2 && changeDuring === "mandate") await replaceStrategy();
    return [currentGrant];
  });
  const balances = api.getBalances.bind(api);
  mock.method(api, "getBalances", async (...args: Parameters<typeof api.getBalances>) => {
    // Each observation reads public/confidential balances: before, sweep, then planning.
    if (++balanceReads === (changeDuring === "sweep" ? 3 : changeDuring === "planning" ? 5 : -1)) await replaceStrategy();
    return balances(...args);
  });

  await tick("schedule");
  assert.equal(ownerSubmissions, 1, "the replacement grant passed the real owner-signature flow");
  assert.equal(settings().maxUsd, 1);
  assert.equal(settings().on, true, "the replacement was explicitly enabled; this is not stop cancellation");
  assert.equal(currentGrant.label, `treasury:${strategyLabelSuffix(loadStrategy())}`);
  assert.deepEqual(sends, [], "the old tick must not spend $50 using its stale $100 ceiling under the new $1 strategy");
  assert.deepEqual(readOps(), []);
});

test("every tick records its start and its end: trigger, settings, mandate, book before and after, plan and steps, no credentials", async () => {
  limit(100);
  await tick("schedule");
  await tick("operator");
  const { ticks: [first, second], corrupt } = ticks();
  assert.deepEqual(corrupt, []);
  assert.equal(first!.trigger, "schedule");
  assert.equal(second!.trigger, "operator");
  assert.deepEqual({ on: first!.schedule.on, everyMin: first!.schedule.everyMin, maxUsd: first!.schedule.maxUsd }, settings());
  assert.equal(first!.grant?.label, grantLabel());
  assert.match(first!.build.source, /^sha256:[0-9a-f]{64}$/);
  assert.match(first!.build.lockfile ?? "", /^sha256:[0-9a-f]{64}$/);
  const done = first!.end!;
  assert.equal(done.plan?.legs.length, 2);
  assert.deepEqual(done.steps.map((s) => s.status), ["SUCCESS", "SUCCESS"]);
  assert.ok("driftBps" in done.before && "driftBps" in done.after && done.before.driftBps > done.after.driftBps);
  // The second tick found the book on target: a correct no-op is still a completed tick.
  assert.equal(second!.end!.plan, null);
  assert.equal(second!.schedule.lastRun, readInbox().filter((e) => e.level === "run").at(-1)!.at, "it records the run its schedule counts from");
  assert.doesNotMatch(readFileSync(join(".evidence", `${process.env.AGENT_ID}.jsonl`), "utf8"), /ngt_/, "no grant token");
});

test("a tick skipped because another is running records its start and end too", async () => {
  limit(100);
  await Promise.all([tick("schedule"), tick("schedule")]);
  assert.deepEqual(ticks().ticks.map((t) => t.end?.outcome.startsWith("Skipped: a tick is already running")).toSorted(), [false, true]);
});

test("a tick whose start can't be recorded doesn't run", async () => {
  limit(100);
  mkdirSync(join(".evidence", `${process.env.AGENT_ID}.jsonl`), { recursive: true }); // a directory where the file should be
  assert.match(await tick("schedule"), /^Not run: the tick's evidence could not be recorded/);
  assert.deepEqual(sends, []);
  assert.equal(readInbox()[0]?.level, "warn");
});

test("a start with no end reads as incomplete, and a torn last line is counted, not trusted", async () => {
  limit(100);
  await tick("schedule");
  const path = join(".evidence", `${process.env.AGENT_ID}.jsonl`);
  const [start] = readFileSync(path, "utf8").split("\n");
  writeFileSync(path, `${start}\n{"kind":"end","id":"`);
  const { ticks: read, corrupt } = ticks();
  assert.equal(read.length, 1);
  assert.equal(read[0]!.end, null);
  assert.deepEqual(corrupt, [2]);
});

test("the source digest identifies a tree: same files, same digest; one changed byte, another", () => {
  const dir = "source";
  mkdirSync(dir);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  const digest = sourceDigest(dir);
  assert.equal(sourceDigest(dir), digest);
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  assert.notEqual(sourceDigest(dir), digest);
});

test("a damaged inbox makes scheduler history unavailable instead of implying no later run", () => {
  const entry = { id: "e1", at: new Date().toISOString(), level: "run", text: "book on target" };
  mkdirSync(".inbox", { recursive: true });
  // A crash mid-append leaves a partial last line.
  writeFileSync(join(".inbox", `${process.env.AGENT_ID}.jsonl`), `${JSON.stringify(entry)}\n{"id":"e2","at":"2026-`);
  assert.throws(readInbox, /line 2; history unavailable/);
  assert.throws(status, /line 2; history unavailable/);
});

test("scheduler cadence follows the recorded run summary, not warnings or an interrupted evidence start", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T12:00:00Z") });
  saveSettings({ on: true, everyMin: 60, maxUsd: 0 });
  assert.equal(status().lastRun, null);
  assert.equal(status().nextRun, "2030-01-01T12:00:00.000Z");
  const completed = post("run", "Skipped: the agent is frozen.");
  t.mock.timers.tick(15 * 60_000);
  const warning = post("warn", "An observation is unavailable.");
  dismiss(warning.id);
  mkdirSync(".evidence", { recursive: true });
  writeFileSync(join(".evidence", `${process.env.AGENT_ID}.jsonl`), JSON.stringify({ kind: "start", id: "interrupted", at: new Date().toISOString() }) + "\n");
  assert.equal(status().lastRun, completed.at);
  assert.equal(status().nextRun, "2030-01-01T13:00:00.000Z");
  saveSettings({ on: false, everyMin: 60, maxUsd: 0 });
  assert.equal(status().nextRun, null);
});


test("intermediate stages and accepted submissions are readable before the tick ends", async () => {
  limit(100);
  const snapshots: Awaited<ReturnType<typeof exportRunLog>>[] = [];
  mock.method(api, "getStatus", async (correlation_id: string) => {
    const active = ticks().ticks[0]!;
    assert.equal(active.end, null);
    // The provider has answered, but settlement is not known yet. Read through the real export path.
    snapshots.push(await exportRunLog(".", process.env.AGENT_ID!, active.id, async () => []));
    return { correlation_id, status: "SUCCESS" };
  });
  await tick("schedule");
  assert.equal(sends.length, 2);
  assert.ok(snapshots.length >= 2);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.completion, "no-recorded-end");
    assert.ok(snapshot.events.some(e => e.type === "STEP_FINISHED" && e.stepName === "planning"));
    assert.ok(snapshot.events.some(e => e.type === "CUSTOM" && e.value.stage === "submission"));
    assert.ok(!snapshot.events.some(e => e.type === "RUN_FINISHED"));
  }
});

test("supplementary progress failure does not change sends or the authoritative outcome", async () => {
  limit(100);
  mkdirSync(".evidence", { recursive: true });
  writeFileSync(".evidence/progress", "blocked");
  await tick("schedule");
  assert.equal(sends.length, 2);
  assert.match(ticks().ticks[0]!.end!.outcome, /step 1: SUCCESS/);
  const snapshot = await exportRunLog(".", process.env.AGENT_ID!, ticks().ticks[0]!.id, async () => []);
  assert.ok(snapshot.gaps.some(g => g.code === "progress_unavailable"));
});


test("accepted submission progress does not resolve a lost status read or permit another send", async () => {
  limit(100);
  mock.method(api, "getStatus", async () => { throw new Error("status unavailable"); });
  assert.match(await tick("schedule"), /Outcome unknown/);
  assert.equal(sends.length, 1);
  assert.equal(readOps().filter(blocksDispatch).length, 1);
  const snapshot = await exportRunLog(".", process.env.AGENT_ID!, ticks().ticks[0]!.id, async () => []);
  assert.ok(snapshot.events.some(e => e.type === "CUSTOM" && e.value.stage === "submission"));
  assert.ok(!snapshot.events.some(e => e.type === "STEP_FINISHED" && e.stepName === "execution"));
  assert.ok(snapshot.gaps.some(g => g.code === "progress_incomplete"));
  await tick("schedule");
  assert.equal(sends.length, 1, "observational progress must never authorize a replay");
});

/** The provider's dry run for every swap: the live swap would be refused with `code` (provider docs: dry runs warn with the live codes). */
const warnedQuotes = (code: string) => mock.method(api, "forGrant", () => ({
  swap: async (_id: string, request: { dry?: boolean; amount: string }) => {
    assert.equal(request.dry, true, "a warned leg must never send");
    return { quote: { amount_out: request.amount, min_amount_out: request.amount }, warnings: [{ code, detail: "detail-not-for-the-owner" }] };
  },
}));

test("a leg the provider warns about is never planned or sent: the tick names the codes and asks the owner once", async () => {
  limit(100);
  warnedQuotes("policy_limit_exceeded");
  const report = await tick("schedule");
  assert.deepEqual(sends, []);
  assert.match(report, /provider's dry run warned \(policy_limit_exceeded\)/);
  assert.doesNotMatch(report, /detail-not-for-the-owner/);
  const asks = () => open().filter(e => /policy_limit_exceeded/.test(e.text));
  assert.equal(asks().length, 1);
  await tick("schedule");
  assert.equal(asks().length, 1, "the same warnings ask the owner once, not every tick");
  dismiss(asks()[0]!.id);
  await tick("schedule");
  assert.equal(asks().length, 0, "a dismissed ask isn't posted again for the same warnings");
  assert.deepEqual(readOps(), [], "nothing is recorded as sent");
});

test("a saved plan whose fresh quote now warns is rejected before it is claimed, and runs once the warning clears", async () => {
  const { rebalance } = await import("../src/treasury.js");
  const { executePlan } = await import("../src/plans.js");
  let planId: string | undefined;
  for await (const event of rebalance()) if (event.type === "saved") planId = event.plan.id;
  assert.ok(planId, "a clean quote saves the plan");
  const restore = warnedQuotes("spend_budget_exceeded");
  const rejected: string[] = [];
  for await (const event of executePlan(planId!)) if (event.type === "rejected") rejected.push(...event.problems);
  assert.match(rejected.join(" "), /provider's dry run warned \(spend_budget_exceeded\)/);
  assert.deepEqual(sends, []);
  assert.deepEqual(readOps(), []);
  restore.mock.restore();
  const statuses: string[] = [];
  for await (const event of executePlan(planId!)) if (event.type === "action") statuses.push(event.status);
  assert.ok(statuses.length > 0 && statuses.every(s => s === "SUCCESS"), "the plan was not claimed by the rejected run");
});

test("a warned leg drops out like a costly one: the rest of the rebalance still executes", async () => {
  limit(100);
  mock.method(api, "forGrant", () => ({
    swap: async (_id: string, request: { dry?: boolean; origin_asset: string; destination_asset: string; amount: string }) => {
      if (request.dry) return { quote: { amount_out: request.amount, min_amount_out: request.amount },
        warnings: request.destination_asset === ASSETS.ETH ? [{ code: "policy_asset_denied", detail: "d" }] : [] };
      assert.notEqual(request.destination_asset, ASSETS.ETH, "the warned leg must never send");
      sends.push(`swap ${request.origin_asset} → ${request.destination_asset}`);
      book[request.origin_asset]!.confidential -= BigInt(request.amount);
      book[request.destination_asset]!.confidential += BigInt(request.amount);
      return { correlation_id: `op_${sends.length}` };
    },
  }));
  const report = await tick("schedule");
  assert.deepEqual(sends, [`swap ${ASSETS.USDC} → ${ASSETS.wNEAR}`]);
  assert.match(report, /swaps left out: .*policy_asset_denied/);
  assert.match(report, /step 1: SUCCESS/);
});
