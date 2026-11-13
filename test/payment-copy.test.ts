import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS } from "../src/policy.js";

import { exactPayment } from "../web/src/shared/payment-copy.js";

test("payment approval copy preserves every unit and the full recipient account", () => {
  for (const [raw, displayed] of [["100000001", "100.000001"], ["1", "0.000001"], ["9007199254740993", "9007199254.740993"]]) {
    assert.equal(exactPayment({ amount: raw, asset: ASSETS.USDC, recipient: "full-recipient.near" }, []), `${displayed} USDC to full-recipient.near`);
  }
});

test("missing decimals or malformed payment terms are explicit instead of guessed", () => {
  assert.equal(exactPayment({ amount: "123", asset: "unknown-asset", recipient: "payee.near" }, []), "123 raw units of unknown-asset to payee.near");
  assert.equal(exactPayment({ amount: "1.2", asset: ASSETS.USDC, recipient: "payee.near" }, []), "Payment terms unavailable");
});
