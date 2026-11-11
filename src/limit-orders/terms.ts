/** Exact spend terms for one provider limit order. Prices are quote units per whole base unit. */
export type LimitOrderTerms = Readonly<{
  base_asset: string;
  quote_asset: string;
  side: "buy" | "sell";
  quantity: string; // Atomic units of the base asset, for either side.
  price: string; // Plain decimal, in whole quote units per one whole base unit.
}>;

export type LimitOrderDecimals = Readonly<{ base: number; quote: number }>;

export type LimitOrderSpend = Readonly<{
  spendAsset: string;
  spendAmount: string; // Atomic units of spendAsset.
  outputAsset: string;
}>;

function assetId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function tokenDecimals(value: number): bigint {
  // Token metadata uses an unsigned byte; require evidence for both sides, even on a sell.
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error("limit_order_token_decimals_invalid");
  return BigInt(value);
}

/**
 * Compute the full atomic amount an order funds, without floating-point rounding.
 * A buy rounds its quote spend up; a sell spends exactly the base quantity.
 */
export function calculateLimitOrderSpend(terms: LimitOrderTerms, decimals: LimitOrderDecimals): LimitOrderSpend {
  if (!assetId(terms.base_asset) || !assetId(terms.quote_asset) || terms.base_asset === terms.quote_asset)
    throw new Error("limit_order_asset_pair_invalid");
  if (terms.side !== "buy" && terms.side !== "sell") throw new Error("limit_order_side_invalid");
  if (typeof terms.quantity !== "string" || !/^[1-9]\d*$/.test(terms.quantity) || terms.quantity.length > 65)
    throw new Error("limit_order_quantity_invalid");
  if (typeof terms.price !== "string" || terms.price.length > 40 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(terms.price))
    throw new Error("limit_order_price_invalid");

  const [whole, fraction = ""] = terms.price.split(".");
  const coefficient = BigInt(`${whole}${fraction}`);
  if (coefficient === 0n) throw new Error("limit_order_price_invalid");
  if (decimals === null || typeof decimals !== "object") throw new Error("limit_order_token_decimals_invalid");
  const baseDecimals = tokenDecimals(decimals.base);
  const quoteDecimals = tokenDecimals(decimals.quote);
  const quantity = BigInt(terms.quantity);

  if (terms.side === "sell") return {
    spendAsset: terms.base_asset,
    spendAmount: terms.quantity,
    outputAsset: terms.quote_asset,
  };

  const numerator = quantity * coefficient * 10n ** quoteDecimals;
  const denominator = 10n ** (baseDecimals + BigInt(fraction.length));
  const quoteSpend = (numerator + denominator - 1n) / denominator;
  return {
    spendAsset: terms.quote_asset,
    spendAmount: quoteSpend.toString(),
    outputAsset: terms.base_asset,
  };
}

/** Reject a preview that prices a different spend asset or atomic amount than the signed terms. */
export function assertLimitOrderPreviewSpend(expected: LimitOrderSpend, quote: unknown): void {
  if (quote === null || typeof quote !== "object" || Array.isArray(quote))
    throw new Error("limit_order_preview_spend_mismatch");
  const fields = quote as Record<string, unknown>;
  if (fields.spend_asset !== expected.spendAsset || fields.spend_amount !== expected.spendAmount)
    throw new Error("limit_order_preview_spend_mismatch");
}
