import type { client } from "./client";
import type { Kind } from "../features/evidence/beats";
export { exactPayment, fromUnits } from "./payment-copy";

export type Overview = Awaited<ReturnType<typeof client.overview>>;
export type Holding = Overview["book"][number];

/** Whether the policy lets the agent swap. The target allocation and rebalancing apply only then. */
export const swaps = (data: Overview) => Boolean(data.policy.policy?.actions.includes("swap"));

/** Configured area is stable across policy changes. Legacy servers retain their policy-based fallback. */
export const kindOf = (data: Overview): Kind => data.area ? (data.area === "treasury" ? "treasury" : "facilitator") : (swaps(data) ? "treasury" : "facilitator");

export const units = (raw: bigint | string, decimals: number) => Number(raw) / 10 ** decimals;

/** An account or id short enough for a badge: its head and tail, when it is longer than `max`. */
export const short = (id: string, max = 20) => (id.length > max ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

export const amount = (raw: bigint | string, h: Pick<Holding, "decimals" | "symbol">) => {
  const n = units(raw, h.decimals);
  const digits = n === 0 ? 0 : n < 1 ? 5 : n < 100 ? 3 : 2;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ${h.symbol}`;
};

/** "1.5" at 6 decimals → "1500000"; null unless it is a positive decimal that fits. */
export function toUnits(value: string, decimals: number) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return raw > 0n ? raw.toString() : null;
}

export const usd = (n: number | string | null | undefined) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function ago(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return relative.format(Math.round(seconds), "second");
}

/** 125 seconds → "2:05". */
export const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
