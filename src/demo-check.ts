import { readFileSync } from "node:fs";
import { bindingWindow } from "./budget-window.js";
import { hostedRpc, required } from "./remote.js";
import { totalUsd } from "./valuation.js";

/**
 * Before a demo: check operational preconditions through the hosted dashboard as the
 * signed-in session in REPORT_COOKIE_FILE. Reads only; sends nothing.
 *
 *   DASHBOARD_URL=https://… REPORT_COOKIE_FILE=… pnpm demo-check
 */

const BASE = new URL(required("DASHBOARD_URL"));
const COOKIE = readFileSync(required("REPORT_COOKIE_FILE"), "utf8").trim();
const rpc = <T>(agent: string, path: string) => hostedRpc<T>(BASE, COOKIE, agent, path);

/** Raw balances arrive as strings (the JSON form of the API's bigints). */
type Holding = { symbol: string; usd: number | null; asset: string; decimals: number; confidential: string };
type Window = { limit_usd: string | null; spent_usd: string | null; remaining_usd: string | null; resets_at: string | null };
type Period = "daily" | "weekly" | "monthly";
type Overview = { book: Holding[]; target: Record<string, number>; rebalance: { minLegUsd: number }; policy: { usage: { budget: Record<Period, Window> } } };

/** A facilitator demo invoice, and roughly what the treasury demo (a steward swap, then the correction) spends. */
const INVOICE_USD = 1;
const TREASURY_DEMO_USD = 5;

const [payout, held, treasury, autopilot] = await Promise.all([
  rpc<Overview>("payout", "overview"),
  rpc<unknown[]>("payout", "held"),
  rpc<Overview>("treasury", "overview"),
  rpc<{ on: boolean; nextRun: string | null }>("treasury", "autopilot/get"),
]);

// A payout is paid only from the confidential balance: public USDC can't pay an invoice.
const payable = payout.book.find((h) => h.symbol === "USDC");
const usdc = payable ? Number(payable.confidential) / 10 ** payable.decimals : 0;
// The window that refuses first, as the Overview shows it.
const binding = bindingWindow(treasury.policy.usage.budget);
const left = Number(binding?.remaining_usd ?? Infinity);
const total = totalUsd(treasury.book);
const legs = total === null ? [] : treasury.book.map((h) => ({ symbol: h.symbol, off: h.usd! - (treasury.target[h.asset] ?? 0) * total }));
const largest = legs.reduce((a, b) => (Math.abs(b.off) > Math.abs(a.off) ? b : a), { symbol: "-", off: 0 });

const checks: [boolean, string][] = [
  [total !== null, total === null ? "Treasury valuation unavailable: a managed holding lacks a usable USD value; allocation cannot be checked" : "Treasury valuation available"],
  [usdc >= INVOICE_USD, `Payout wallet: ${usdc.toFixed(2)} confidential USDC (a demo invoice needs $${INVOICE_USD}; top up from the treasury's Funding page)`],
  [held.length === 0, `Payments already waiting for approval: ${held.length}`],
  [left >= TREASURY_DEMO_USD, binding
    ? `Treasury ${binding.period} budget left: $${left.toFixed(2)} of $${binding.limit_usd} (the treasury demo spends about $${TREASURY_DEMO_USD}${binding.resets_at ? `; resets ${binding.resets_at}` : ""})`
    : "Treasury budget: no USD limit set"],
  [autopilot.on, `Autopilot ${autopilot.on ? `on, next tick ${autopilot.nextRun}` : "off"}`],
];
for (const [ok, line] of checks) console.log(`${ok ? "ok  " : "FIX "} ${line}`);
// Not a check: any drift is fine, but it says whether the next tick will rebalance on camera.
if (total !== null) console.log(`     Treasury book $${total.toFixed(2)}; furthest from target: ${largest.symbol} ${largest.off >= 0 ? "+" : ""}$${largest.off.toFixed(2)} (the autopilot acts from $${treasury.rebalance.minLegUsd} a leg)`);
process.exitCode = checks.every(([ok]) => ok) ? 0 : 1;
