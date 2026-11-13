import { ASSETS } from "../../../src/contract/assets.js";

/** "1500000" at 6 decimals → "1.5", exactly: the inverse of `toUnits`. */
export function fromUnits(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ""}`;
}

/** Exact payment terms for a decision; never rounded and never replace the account with an alias. */
export function exactPayment(request: Record<string, unknown>, book: { asset: string; decimals: number; symbol: string }[]) {
  const { amount: raw, asset, recipient } = request;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || typeof asset !== "string" || typeof recipient !== "string") return "Payment terms unavailable";
  const token = book.find((h) => h.asset === asset) ?? (asset === ASSETS.USDC ? { asset: ASSETS.USDC, decimals: 6, symbol: "USDC" } : undefined);
  return `${token ? `${fromUnits(raw, token.decimals)} ${token.symbol}` : `${raw} raw units of ${asset}`} to ${recipient}`;
}
