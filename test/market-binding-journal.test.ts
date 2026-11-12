import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { freshDirectory, TSX } from "./fixtures/harness.js";
import { acquireMoneyLock } from "../src/lock.js";
import { blocksDispatch, claimSubmission, marketStageKey, opsLog, readMarketBindings, readOps, record, recordMarketBinding, recordMarketLanding } from "../src/ops.js";
import { requestKey } from "../src/request-key.js";
import { ASSETS } from "../src/policy.js";
import { briefDigest, OPEN_ACCOUNT_WNEAR, type HireTerms } from "../src/market/x402.js";
import { legacyMarketFunding, marketFundingNeedsReview, pendingMarketFunding } from "../src/market/binding-guard.js";

freshDirectory("market-binding-journal");
beforeEach(() => { process.env.AGENT_ID = "a".repeat(64); });

const actor = "app:staging:acme", requestId = "hire-1", brief = "Write the report";
const approved: HireTerms = { handle: "writer", brief: briefDigest(brief), network: "near:mainnet", asset: ASSETS.USDC.slice(7),
  payTo: "market.near", amount: "500000", maxTimeoutSeconds: 900 };
const binding = () => ({ idempotencyKey: requestKey(actor, requestId), actor, requestId, brief, approved,
  paymentAccount: "payment.near", publicKey: `ed25519:${"A".repeat(43)}` });
const paymentRequest = () => ({ handle: approved.handle, brief, messageId: "message-1",
  row: { scheme: "exact", network: approved.network, asset: approved.asset, amount: approved.amount,
    payTo: approved.payTo, maxTimeoutSeconds: approved.maxTimeoutSeconds },
  asset: ASSETS.USDC, amount: approved.amount, payer: binding().paymentAccount, publicKey: binding().publicKey,
  nonce: "1", maxBlockHeight: "1000", balanceAtSigning: approved.amount });

test("a v3 hire binding survives lock recovery and is not projected as a money operation", async () => {
  recordMarketBinding(binding());
  assert.deepEqual(readOps(), []);
  const [saved] = readMarketBindings();
  assert.deepEqual(saved && { ...saved, at: undefined }, { ...binding(), at: undefined, landed: {} });
  assert.equal(JSON.parse(readFileSync(opsLog(), "utf8").trim()).journalVersion, 3);
  const lock = await acquireMoneyLock();
  await lock.release();
  assert.deepEqual(readOps(), [], "resolveUnsubmitted must never retire a binding as an unsent operation");
  assert.deepEqual(readMarketBindings()[0]?.landed, {});
});

const cancelPreparation = {
  at: "2026-11-11T12:00:00.000Z", idempotencyKey: `limit-order-cancel:${"b".repeat(32)}`,
  kind: "limit-order-cancel", method: "limit_order_cancel" as const, journalVersion: 2 as const,
  request: { proposalId: "b".repeat(32), orderId: "mixed-journal-order" },
  policyRevision: null, policyDigest: null, originalOrderPolicyDigest: `sha256:${"c".repeat(64)}`,
};
const cancelClaim = { idempotencyKey: cancelPreparation.idempotencyKey, submissionState: "SUBMISSION_ATTEMPTED" as const };
const cancelFinal = { idempotencyKey: cancelPreparation.idempotencyKey, cancelFinal: true as const };

test("one journal keeps a v3 market binding separate from a claimed limit-order cancellation", () => {
  recordMarketBinding(binding());
  const savedBinding = readMarketBindings();
  record(cancelPreparation);
  claimSubmission(cancelPreparation.idempotencyKey, cancelPreparation.request);
  const [claimed] = readOps();
  assert.equal(readOps().length, 1, "the v3 binding is not projected as an operation");
  assert.equal(claimed?.method, "limit_order_cancel");
  assert.equal(claimed?.originalOrderPolicyDigest, cancelPreparation.originalOrderPolicyDigest,
    "the shared parser retains the original cancellation mandate");
  assert.equal(claimed?.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(blocksDispatch(claimed!), true, "a submission claim does not prove final payout");
  assert.deepEqual(readMarketBindings(), savedBinding);
  record(cancelFinal);
  const [completed] = readOps();
  assert.equal(completed?.cancelFinal, true);
  assert.equal(blocksDispatch(completed!), false);
  assert.deepEqual(readMarketBindings(), savedBinding, "cancel completion never consumes or retires market metadata");
});

for (const [name, lines] of Object.entries({
  "unversioned cancellation": [{ ...cancelPreparation, journalVersion: undefined }, cancelClaim],
  "repeated submission claim": [cancelPreparation, cancelClaim, cancelClaim],
  "completion before submission": [cancelPreparation, cancelFinal],
  "acceptance presented as final payout": [cancelPreparation, cancelClaim,
    { idempotencyKey: cancelPreparation.idempotencyKey, correlation_id: "cancel-acceptance", status: "SUCCESS" }],
  "refusal after submission": [cancelPreparation, cancelClaim,
    { idempotencyKey: cancelPreparation.idempotencyKey, refused: "never_submitted" }],
  "repeated final payout": [cancelPreparation, cancelClaim, cancelFinal, cancelFinal],
})) test(`v3 market metadata cannot hide ${name} from either journal projection`, () => {
  recordMarketBinding(binding());
  const raw = readFileSync(opsLog(), "utf8") + lines.map(line => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(opsLog(), raw);
  assert.throws(readOps, /Invalid operation journal/);
  assert.throws(readMarketBindings, /Invalid operation journal/,
    "reading only market bindings must still validate cancellation lifecycle evidence");
  assert.equal(readFileSync(opsLog(), "utf8"), raw, "both failed projections preserve every original byte");
});

for (const landedBeforeRestart of [false, true]) test(
  `a fresh process retains the payment-key reservation ${landedBeforeRestart ? "after landing before x402" : "after provider SUCCESS before landing"}`,
  { timeout: 20_000 }, () => {
    const original = binding();
    recordMarketBinding(original);
    const stageKey = marketStageKey(original.idempotencyKey, "usdc");
    const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near",
      recipient: original.paymentAccount, confidential: true };
    record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw",
      journalVersion: 2, request });
    claimSubmission(stageKey, request);
    record({ idempotencyKey: stageKey, correlation_id: "restart-funding", status: "SUCCESS" });
    const landing = { bindingKey: original.idempotencyKey, stage: "usdc" as const, correlationId: "restart-funding",
      destinationTxHash: "restart-destination", finalHeight: "123" };
    if (landedBeforeRestart) recordMarketLanding(landing);
    const before = readFileSync(opsLog(), "utf8");
    const child = spawnSync(TSX, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { acquireMoneyLock } from ${JSON.stringify(new URL("../src/lock.ts", import.meta.url).href)};
      import { readOps, readMarketBindings, recordMarketLanding } from ${JSON.stringify(new URL("../src/ops.ts", import.meta.url).href)};
      import { pendingMarketFunding, legacyMarketFunding } from ${JSON.stringify(new URL("../src/market/binding-guard.ts", import.meta.url).href)};
      const original = ${JSON.stringify(original)};
      const stageKey = ${JSON.stringify(stageKey)};
      const otherKey = ${JSON.stringify(requestKey(actor, "hire-after-restart"))};
      const lock = await acquireMoneyLock();
      try {
        const [saved] = readMarketBindings();
        assert.deepEqual(saved && { ...saved, at: undefined, landed: undefined },
          { ...original, at: undefined, landed: undefined }, "the original ID, terms and key survive restart");
        assert.equal(readOps().length, 1, "restart must not prepare another funding or x402 operation");
        assert.equal(readOps()[0]?.idempotencyKey, stageKey);
        assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
        assert.equal(readOps()[0]?.status, "SUCCESS");
        assert.equal(legacyMarketFunding(original.paymentAccount), null, "the persisted stage keeps its binding");
        assert.equal(pendingMarketFunding(original.paymentAccount, otherKey)?.binding.idempotencyKey,
          original.idempotencyKey, "another request cannot consume the restarted hire's funding");
        if (!${landedBeforeRestart}) {
          assert.deepEqual(saved.landed, {}, "provider SUCCESS does not imply final landing");
          assert.equal(pendingMarketFunding(original.paymentAccount, original.idempotencyKey)?.op.idempotencyKey,
            stageKey, "even the original hire waits for final landing proof");
          // Stand-in final receipt evidence: append only the original stage's proof, never a new withdrawal.
          recordMarketLanding(${JSON.stringify(landing)});
        }
        assert.deepEqual(readMarketBindings()[0]?.landed.usdc,
          { correlationId: "restart-funding", destinationTxHash: "restart-destination", finalHeight: "123" });
        assert.equal(pendingMarketFunding(original.paymentAccount, original.idempotencyKey), null,
          "the same ID can continue after its persisted final proof");
        assert.equal(pendingMarketFunding(original.paymentAccount, otherKey)?.op.idempotencyKey, stageKey,
          "landing does not release the funds to another ID before x402");
        assert.equal(readOps().length, 1, "recovery appends no money operation");
      } finally { await lock.release(); }
    `], { cwd: process.cwd(), env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 15_000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const after = readFileSync(opsLog(), "utf8");
    if (landedBeforeRestart) assert.equal(after, before, "reading proven funding after restart does not rewrite the journal");
    else {
      assert.ok(after.startsWith(before), "restart preserves all pre-landing evidence");
      assert.equal(after.slice(before.length).trim().split("\n").length, 1, "only one final landing line is added");
      assert.equal(JSON.parse(after.slice(before.length)).kind, "market-landing");
    }
    assert.equal(readOps().length, 1);
  });

test("binding identity and exact terms cannot be rewritten", () => {
  recordMarketBinding(binding());
  assert.throws(() => recordMarketBinding(binding()), /already recorded/);
  assert.throws(() => recordMarketBinding({ ...binding(), brief: "Different work",
    approved: { ...approved, brief: briefDigest("Different work") } }), /already recorded/);
  assert.throws(() => recordMarketBinding({ ...binding(), idempotencyKey: "not-the-request-key" }), /identity|key/i);
  assert.equal(readMarketBindings().length, 1);
});

test("a duplicate binding line copied into the log fails closed", async () => {
  recordMarketBinding(binding());
  const first = readFileSync(opsLog(), "utf8");
  writeFileSync(opsLog(), first + first);
  assert.throws(readMarketBindings, /duplicate market binding/);
  assert.throws(readOps, /duplicate market binding/);
  await assert.rejects(acquireMoneyLock(), /duplicate market binding/);
  assert.equal(readFileSync(opsLog(), "utf8"), first + first);
});

test("opening and USDC stage identities are deterministic and distinct from each other and the payment", () => {
  const key = binding().idempotencyKey;
  assert.equal(marketStageKey(key, "open"), marketStageKey(key, "open"));
  assert.notEqual(marketStageKey(key, "open"), marketStageKey(key, "usdc"));
  assert.notEqual(marketStageKey(key, "usdc"), key);
  assert.notEqual(marketStageKey(key, "open"), marketStageKey(requestKey(actor, "hire-2"), "open"));
});

test("a submitted pre-binding top-up remains a legacy gate even after provider SUCCESS", () => {
  const legacyKey = "market-topup:old-random-id";
  const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: legacyKey, kind: "market-topup", method: "withdraw",
    journalVersion: 2, request });
  claimSubmission(legacyKey, request);
  record({ idempotencyKey: legacyKey, correlation_id: "legacy-op", status: "SUCCESS" });
  assert.equal(legacyMarketFunding(binding().paymentAccount)?.idempotencyKey, legacyKey);
  assert.equal(legacyMarketFunding("unrelated-key.near"), null, "the legacy op is scoped to its original key");
  recordMarketBinding(binding());
  assert.equal(legacyMarketFunding(binding().paymentAccount)?.idempotencyKey, legacyKey,
    "a new binding cannot retrospectively assign an old top-up to its request ID");
});

test("a bound funding stage is not mistaken for legacy funding", () => {
  recordMarketBinding(binding());
  const key = marketStageKey(binding().idempotencyKey, "usdc");
  const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "market-topup", method: "withdraw",
    journalVersion: 2, request });
  claimSubmission(key, request);
  assert.equal(legacyMarketFunding(binding().paymentAccount), null);
});

for (const [status, review] of [
  ["SUCCESS", true], ["FAILED", true], ["REFUNDED", true], ["NEEDS_REVIEW", true],
  ["UNKNOWN", true], ["UNCERTAIN", true], ["MOVING", false], ["QUEUED", false],
] as const) test(`an unproved opening stage with provider ${status} ${review ? "needs review" : "is still funding"}`, () => {
  recordMarketBinding(binding());
  const key = marketStageKey(binding().idempotencyKey, "open");
  const request = { asset: ASSETS.wNEAR, amount: OPEN_ACCOUNT_WNEAR, chain: "near",
    recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "market-topup", method: "withdraw",
    journalVersion: 2, request });
  claimSubmission(key, request);
  record({ idempotencyKey: key, correlation_id: "opening-op", status });
  assert.equal(marketFundingNeedsReview(readMarketBindings()[0]!, readOps()), review);
  assert.equal(pendingMarketFunding(binding().paymentAccount)?.stage, "open", "review does not release the key");
  if (status === "SUCCESS") {
    recordMarketLanding({ bindingKey: binding().idempotencyKey, stage: "open", correlationId: "opening-op",
      destinationTxHash: "opening-hash", finalHeight: "123" });
    assert.equal(marketFundingNeedsReview(readMarketBindings()[0]!, readOps()), false);
  }
});

test("landed funding stays reserved to other requests while its own hire can continue", () => {
  recordMarketBinding(binding());
  const stageKey = marketStageKey(binding().idempotencyKey, "open");
  const request = { asset: ASSETS.wNEAR, amount: OPEN_ACCOUNT_WNEAR, chain: "near",
    recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw",
    journalVersion: 2, request });
  claimSubmission(stageKey, request);
  record({ idempotencyKey: stageKey, correlation_id: "opening-op", status: "SUCCESS" });
  assert.equal(pendingMarketFunding(binding().paymentAccount, binding().idempotencyKey)?.stage, "open",
    "even this hire waits until its submitted credit is proved");
  recordMarketLanding({ bindingKey: binding().idempotencyKey, stage: "open", correlationId: "opening-op",
    destinationTxHash: "opening-hash", finalHeight: "123" });
  assert.equal(pendingMarketFunding(binding().paymentAccount, binding().idempotencyKey), null);
  assert.equal(pendingMarketFunding(binding().paymentAccount)?.stage, "open",
    "the landed balance cannot be borrowed by a second hire");
});

test("one destination transaction cannot prove two submitted funding stages", () => {
  const first = binding();
  const second = { ...binding(), requestId: "hire-2", idempotencyKey: requestKey(actor, "hire-2") };
  for (const [item, correlationId] of [[first, "first-op"], [second, "second-op"]] as const) {
    recordMarketBinding(item);
    const stageKey = marketStageKey(item.idempotencyKey, "usdc");
    const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near",
      recipient: item.paymentAccount, confidential: true };
    record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw",
      journalVersion: 2, request });
    claimSubmission(stageKey, request);
    record({ idempotencyKey: stageKey, correlation_id: correlationId, status: "SUCCESS" });
  }
  recordMarketLanding({ bindingKey: first.idempotencyKey, stage: "usdc", correlationId: "first-op",
    destinationTxHash: "shared-hash", finalHeight: "123" });
  const before = readFileSync(opsLog(), "utf8");
  assert.throws(() => recordMarketLanding({ bindingKey: second.idempotencyKey, stage: "usdc",
    correlationId: "second-op", destinationTxHash: "shared-hash", finalHeight: "124" }), /transaction already proved/);
  assert.equal(readFileSync(opsLog(), "utf8"), before);
  assert.deepEqual(readMarketBindings().find(item => item.idempotencyKey === second.idempotencyKey)?.landed, {});
  writeFileSync(opsLog(), before + JSON.stringify({ at: new Date().toISOString(), idempotencyKey: second.idempotencyKey,
    kind: "market-landing", journalVersion: 3, marketLanding: { stage: "usdc", correlationId: "second-op",
      destinationTxHash: "shared-hash", finalHeight: "124" } }) + "\n");
  assert.throws(readMarketBindings, /transaction reused/);
  assert.throws(readOps, /transaction reused/);
});

for (const refusal of ["grant_missing", "never_submitted"] as const) test(`a ${refusal} USDC stage closes an earlier opening reservation`, () => {
  recordMarketBinding(binding());
  const openingKey = marketStageKey(binding().idempotencyKey, "open");
  const opening = { asset: ASSETS.wNEAR, amount: OPEN_ACCOUNT_WNEAR, chain: "near",
    recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: openingKey, kind: "market-topup", method: "withdraw",
    journalVersion: 2, request: opening });
  claimSubmission(openingKey, opening);
  record({ idempotencyKey: openingKey, correlation_id: "opening-op", status: "SUCCESS" });
  recordMarketLanding({ bindingKey: binding().idempotencyKey, stage: "open", correlationId: "opening-op",
    destinationTxHash: "opening-hash", finalHeight: "123" });
  assert.equal(pendingMarketFunding(binding().paymentAccount)?.stage, "open");
  const usdcKey = marketStageKey(binding().idempotencyKey, "usdc");
  record({ at: new Date().toISOString(), idempotencyKey: usdcKey, kind: "market-topup", method: "withdraw",
    journalVersion: 2, request: { asset: ASSETS.USDC, amount: approved.amount, chain: "near",
      recipient: binding().paymentAccount, confidential: true } });
  record({ idempotencyKey: usdcKey, refused: refusal });
  assert.equal(pendingMarketFunding(binding().paymentAccount), null,
    "a request with a proven unsent final stage no longer owns the shared key");
});

test("the later x402 money operation may use the binding's request key without replacing its identity", () => {
  const key = binding().idempotencyKey;
  recordMarketBinding(binding());
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "market-hire", method: "x402", journalVersion: 2,
    request: paymentRequest() });
  assert.equal(readOps()[0]?.idempotencyKey, key);
  assert.equal(readMarketBindings()[0]?.idempotencyKey, key);
  assert.equal(readMarketBindings()[0]?.brief, brief);
});

test("landing marker needs the matching submitted successful top-up and cannot be duplicated", () => {
  const key = binding().idempotencyKey;
  recordMarketBinding(binding());
  const landing = { bindingKey: key, stage: "usdc" as const, correlationId: "op-1", destinationTxHash: "tx-1", finalHeight: "123" };
  assert.throws(() => recordMarketLanding(landing), /stage|operation|top-up/i);
  const stageKey = marketStageKey(key, "usdc");
  const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw", journalVersion: 2, request });
  assert.throws(() => recordMarketLanding(landing), /submitted|success/i);
  claimSubmission(stageKey, request);
  record({ idempotencyKey: stageKey, correlation_id: "op-1", status: "SUCCESS" });
  assert.throws(() => recordMarketLanding({ ...landing, correlationId: "op-other" }), /correlation/i);
  recordMarketLanding(landing);
  assert.deepEqual(readMarketBindings()[0]?.landed.usdc, { correlationId: "op-1", destinationTxHash: "tx-1", finalHeight: "123" });
  assert.throws(() => recordMarketLanding(landing), /already recorded/);
  assert.equal(readOps().length, 1);
});

test("a short USDC landing atomically refuses its binding", () => {
  const key = binding().idempotencyKey;
  recordMarketBinding(binding());
  const stageKey = marketStageKey(key, "usdc");
  const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw", journalVersion: 2, request });
  claimSubmission(stageKey, request);
  record({ idempotencyKey: stageKey, correlation_id: "op-1", status: "SUCCESS" });
  recordMarketLanding({ bindingKey: key, stage: "usdc", correlationId: "op-1", destinationTxHash: "tx-1",
    finalHeight: "123", bindingRefusal: "funding_shortfall" });
  assert.equal(readMarketBindings()[0]?.refused, "funding_shortfall");
  const last = readFileSync(opsLog(), "utf8").trim().split("\n").at(-1);
  assert.equal(JSON.parse(last!).marketLanding.bindingRefusal, "funding_shortfall");
  assert.equal(readOps().length, 1);
  assert.throws(() => recordMarketLanding({ bindingKey: key, stage: "usdc", correlationId: "op-1",
    destinationTxHash: "tx-1", finalHeight: "123" }), /already recorded|refused/i);
  assert.throws(() => record({ at: new Date().toISOString(), idempotencyKey: key, kind: "market-hire", method: "x402", journalVersion: 2,
    request: paymentRequest() }), /refus/i);
});

test("only USDC landing can refuse and a payment preparation bars a later refusal", () => {
  const key = binding().idempotencyKey;
  recordMarketBinding(binding());
  const stageKey = marketStageKey(key, "open");
  const request = { asset: ASSETS.wNEAR, amount: OPEN_ACCOUNT_WNEAR, chain: "near",
    recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw", journalVersion: 2, request });
  claimSubmission(stageKey, request);
  record({ idempotencyKey: stageKey, correlation_id: "op-open", status: "SUCCESS" });
  const before = readFileSync(opsLog(), "utf8");
  assert.throws(() => recordMarketLanding({ bindingKey: key, stage: "open", correlationId: "op-open",
    destinationTxHash: "tx-open", finalHeight: "123", bindingRefusal: "funding_shortfall" }), /USDC|invalid/i);
  assert.equal(readFileSync(opsLog(), "utf8"), before);
  recordMarketLanding({ bindingKey: key, stage: "open", correlationId: "op-open", destinationTxHash: "tx-open", finalHeight: "123" });
  const usdcKey = marketStageKey(key, "usdc");
  const usdcRequest = { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: usdcKey, kind: "market-topup", method: "withdraw", journalVersion: 2,
    request: usdcRequest });
  claimSubmission(usdcKey, usdcRequest);
  record({ idempotencyKey: usdcKey, correlation_id: "op-usdc", status: "SUCCESS" });
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "market-hire", method: "x402", journalVersion: 2,
    request: paymentRequest() });
  const beforeRefusal = readFileSync(opsLog(), "utf8");
  assert.throws(() => recordMarketLanding({ bindingKey: key, stage: "usdc", correlationId: "op-usdc",
    destinationTxHash: "tx-usdc", finalHeight: "123", bindingRefusal: "funding_shortfall" }), /payment|refus/i);
  assert.equal(readFileSync(opsLog(), "utf8"), beforeRefusal);
});

test("a forged payment after a refused landing fails every journal read", async () => {
  const key = binding().idempotencyKey;
  recordMarketBinding(binding());
  const stageKey = marketStageKey(key, "usdc");
  const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: binding().paymentAccount, confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw", journalVersion: 2, request });
  claimSubmission(stageKey, request);
  record({ idempotencyKey: stageKey, correlation_id: "op-usdc", status: "SUCCESS" });
  recordMarketLanding({ bindingKey: key, stage: "usdc", correlationId: "op-usdc", destinationTxHash: "tx-usdc",
    finalHeight: "123", bindingRefusal: "funding_shortfall" });
  const forged = { at: new Date().toISOString(), idempotencyKey: key, kind: "market-hire", method: "x402", journalVersion: 2,
    request: paymentRequest() };
  writeFileSync(opsLog(), readFileSync(opsLog(), "utf8") + JSON.stringify(forged) + "\n");
  assert.throws(readMarketBindings, /refus/i);
  assert.throws(readOps, /refus/i);
  await assert.rejects(acquireMoneyLock(), /refus/i);
});

test("a conflicting money preparation cannot be appended under a binding's request key", () => {
  const key = binding().idempotencyKey;
  recordMarketBinding(binding());
  const before = readFileSync(opsLog(), "utf8");
  assert.throws(() => record({ at: new Date().toISOString(), idempotencyKey: key, kind: "payout", method: "withdraw",
    journalVersion: 2, request: { asset: ASSETS.USDC, amount: "1", chain: "near", recipient: "other.near" } }), /binding|payment/i);
  assert.equal(readFileSync(opsLog(), "utf8"), before);
  assert.deepEqual(readOps(), []);
});

for (const [name, change] of Object.entries({
  "wrong recipient": { request: { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: "other.near", confidential: true } },
  "wrong amount": { request: { asset: ASSETS.USDC, amount: (BigInt(approved.amount) + 1n).toString(), chain: "near",
    recipient: binding().paymentAccount, confidential: true } },
  "wrong kind": { kind: "payout" },
  "wrong version": { journalVersion: undefined },
})) test(`a malformed funding stage (${name}) fails before append`, () => {
  recordMarketBinding(binding());
  const before = readFileSync(opsLog(), "utf8");
  const stage = { at: new Date().toISOString(), idempotencyKey: marketStageKey(binding().idempotencyKey, "usdc"),
    kind: "market-topup", method: "withdraw" as const, journalVersion: 2 as const,
    request: { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: binding().paymentAccount, confidential: true },
    ...change };
  assert.throws(() => record(stage), /binding|stage/i);
  assert.equal(readFileSync(opsLog(), "utf8"), before);
  assert.deepEqual(readOps(), []);
});

for (const [name, change] of Object.entries({
  amount: { amount: "1", row: { ...paymentRequest().row, amount: "1" } },
  payee: { row: { ...paymentRequest().row, payTo: "attacker.near" } },
  window: { row: { ...paymentRequest().row, maxTimeoutSeconds: 901 } },
  malformed: { row: { amount: "500000" } },
})) test(`a bound payment with changed ${name} fails before append and during replay`, () => {
  const key = binding().idempotencyKey;
  recordMarketBinding(binding());
  const forged = { at: new Date().toISOString(), idempotencyKey: key, kind: "market-hire", method: "x402" as const, journalVersion: 2 as const,
    request: { ...paymentRequest(), ...change } };
  const before = readFileSync(opsLog(), "utf8");
  assert.throws(() => record(forged), /binding|payment/i);
  assert.equal(readFileSync(opsLog(), "utf8"), before);
  writeFileSync(opsLog(), before + JSON.stringify(forged) + "\n");
  assert.throws(readOps, /binding|payment/i);
  assert.throws(readMarketBindings, /binding|payment/i);
});

test("invalid binding or landing records fail closed without rewriting the log", async () => {
  const lines = [
    { at: new Date().toISOString(), idempotencyKey: binding().idempotencyKey, kind: "market-binding", journalVersion: 3,
      binding: { actor, requestId, brief, approved, paymentAccount: binding().paymentAccount, publicKey: binding().publicKey } },
    { at: new Date().toISOString(), idempotencyKey: binding().idempotencyKey, marketLanding: { stage: "usdc", correlationId: "op-1", destinationTxHash: "tx-1", finalHeight: "123" } },
  ];
  const raw = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(opsLog(), raw);
  assert.throws(readMarketBindings, /Invalid operation journal/);
  assert.throws(readOps, /Invalid operation journal/);
  await assert.rejects(acquireMoneyLock(), /Invalid operation journal/);
  assert.equal(readFileSync(opsLog(), "utf8"), raw);
});

for (const [name, change] of Object.entries({
  "wrong caller identity": { idempotencyKey: "request:other" },
  "wrong approved brief": { binding: { actor, requestId, brief, approved: { ...approved, brief: "0".repeat(64) },
    paymentAccount: binding().paymentAccount, publicKey: binding().publicKey } },
  "unknown journal version": { journalVersion: 4 },
  "unknown metadata": { ignored: true },
})) test(`invalid market binding (${name}) refuses every journal read`, async () => {
  const line = { at: new Date().toISOString(), idempotencyKey: binding().idempotencyKey, kind: "market-binding", journalVersion: 3,
    binding: { actor, requestId, brief, approved, paymentAccount: binding().paymentAccount, publicKey: binding().publicKey }, ...change };
  const raw = JSON.stringify(line) + "\n";
  writeFileSync(opsLog(), raw);
  assert.throws(readMarketBindings, /Invalid operation journal/);
  assert.throws(readOps, /Invalid operation journal/);
  await assert.rejects(acquireMoneyLock(), /Invalid operation journal/);
  assert.equal(readFileSync(opsLog(), "utf8"), raw);
});
