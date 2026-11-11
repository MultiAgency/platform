import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLimitOrderPreviewSpend, calculateLimitOrderSpend } from "../src/limit-orders/terms.js";

const wNEAR = "nep141:wrap.near";
const USDC = "nep141:usdc.near";
const decimals = { base: 24, quote: 6 };
const order = { base_asset: wNEAR, quote_asset: USDC, quantity: "1000000000000000000000000", price: "5.2" };

test("a sell spends the exact base quantity and names the quote output", () => {
  assert.deepEqual(calculateLimitOrderSpend({ ...order, side: "sell" }, decimals), {
    spendAsset: wNEAR, spendAmount: order.quantity, outputAsset: USDC,
  });
});

test("a buy spends the exact rounded-up quote amount and names the base output", () => {
  assert.deepEqual(calculateLimitOrderSpend({ ...order, side: "buy" }, decimals), {
    spendAsset: USDC, spendAmount: "5200000", outputAsset: wNEAR,
  });
  assert.equal(calculateLimitOrderSpend({ ...order, side: "buy", quantity: "1", price: "0.1" }, decimals).spendAmount,
    "1", "a positive fractional atomic quote spend rounds up, never down to zero");
  assert.equal(calculateLimitOrderSpend({ base_asset: wNEAR, quote_asset: USDC, side: "buy", quantity: "125", price: "2.1" },
    { base: 2, quote: 6 }).spendAmount, "2625000");
});

test("both token decimals must be present and valid", () => {
  for (const evidence of [undefined, { base: undefined, quote: 6 }, { base: 24, quote: undefined },
    { base: -1, quote: 6 }, { base: 24.5, quote: 6 }, { base: 24, quote: 256 }, { base: 24, quote: NaN }])
    assert.throws(() => calculateLimitOrderSpend({ ...order, side: "sell" }, evidence as { base: number; quote: number }),
      /limit_order_token_decimals_invalid/);
});

test("invalid or ambiguous asset pairs, quantities and prices refuse before arithmetic", () => {
  for (const pair of [{ base_asset: USDC, quote_asset: USDC }, { base_asset: "", quote_asset: USDC },
    { base_asset: wNEAR, quote_asset: " USDC" }])
    assert.throws(() => calculateLimitOrderSpend({ ...order, ...pair, side: "buy" }, decimals), /limit_order_asset_pair_invalid/);
  for (const quantity of ["0", "00", "01", "-1", "1.5", "1e2", "", "9".repeat(66)])
    assert.throws(() => calculateLimitOrderSpend({ ...order, quantity, side: "buy" }, decimals), /limit_order_quantity_invalid/);
  for (const price of ["0", "0.000", "00.1", "01", ".5", "5.", "-1", "+1", "1e2", " 1", "1 ", "1,000", "1".repeat(41)])
    assert.throws(() => calculateLimitOrderSpend({ ...order, price, side: "buy" }, decimals), /limit_order_price_invalid/);
  assert.equal(calculateLimitOrderSpend({ ...order, price: `0.${"0".repeat(37)}1`, side: "buy" }, decimals).spendAmount, "1",
    "a positive 40-character plain decimal is accepted");
});

test("a dry preview must agree on the exact spend asset and atomic amount", () => {
  const expected = calculateLimitOrderSpend({ ...order, side: "buy" }, decimals);
  assert.doesNotThrow(() => assertLimitOrderPreviewSpend(expected, { spend_asset: USDC, spend_amount: "5200000" }));
  for (const quote of [null, {}, { spend_asset: wNEAR, spend_amount: "5200000" },
    { spend_asset: USDC, spend_amount: "5199999" }, { spend_asset: USDC, spend_amount: 5200000 },
    { spend_asset: USDC, spend_amount: "05200000" }])
    assert.throws(() => assertLimitOrderPreviewSpend(expected, quote), /limit_order_preview_spend_mismatch/);
});
