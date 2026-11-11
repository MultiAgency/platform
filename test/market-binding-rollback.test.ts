import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { freshDirectory } from "./fixtures/harness.js";
import { readOps as readOpsPreBinding } from "./fixtures/ops-056.js";
import { opsLog, readMarketBindings, readOps, recordMarketBinding } from "../src/ops.js";
import { requestKey } from "../src/request-key.js";
import { ASSETS } from "../src/policy.js";
import { briefDigest } from "../src/market/x402.js";

freshDirectory("market-binding-rollback");
beforeEach(() => { process.env.AGENT_ID = "a".repeat(64); });

test("the actual 0.5.7 journal reader refuses the first v3 binding without changing state", () => {
  assert.deepEqual(readOpsPreBinding(), [], "the frozen reader handles an empty prior journal");
  const actor = "app:staging:acme", requestId = "hire-1", brief = "Write the report";
  recordMarketBinding({
    idempotencyKey: requestKey(actor, requestId), actor, requestId, brief,
    approved: { handle: "writer", brief: briefDigest(brief), network: "near:mainnet", asset: ASSETS.USDC.slice(7),
      payTo: "market.near", amount: "500000", maxTimeoutSeconds: 900 },
    paymentAccount: "payment.near", publicKey: `ed25519:${"A".repeat(43)}`,
  });
  const before = readFileSync(opsLog(), "utf8");
  assert.equal(JSON.parse(before.trim()).journalVersion, 3);
  assert.deepEqual(readOps(), [], "the new reader keeps the binding out of money operations");
  assert.equal(readMarketBindings().length, 1);
  assert.throws(readOpsPreBinding, /Invalid operation journal at line 1: unsupported record shape/);
  assert.equal(readFileSync(opsLog(), "utf8"), before, "the old reader must not rewrite the binding");
});
