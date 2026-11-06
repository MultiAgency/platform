import { tokenUsd } from "./valuation.js";
import { usdValue } from "./value.js";

/** A finite Number's shortest decimal representation, without rounding it during addition. */
function decimal(value: number) {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length - Number(exponent) };
}

/**
 * Compare recorded numeric USD estimates exactly as their decimal representations. This does not
 * recover precision lost when each estimate was calculated, or establish provider accounting.
 * Unknown or invalid evidence remains unknown even when the other values already exceed the limit.
 */
export function withinRunCeiling(values: readonly (number | null | undefined)[], maxUsd: number): boolean | null {
  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd < 0) return null;
  const limit = decimal(maxUsd);
  const amounts: ReturnType<typeof decimal>[] = [];
  let scale = limit.scale;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    const amount = decimal(value);
    amounts.push(amount);
    scale = Math.max(scale, amount.scale);
  }
  const atScale = (amount: ReturnType<typeof decimal>) => amount.units * 10n ** BigInt(scale - amount.scale);
  const ceiling = atScale(limit);
  let total = 0n;
  for (const amount of amounts) {
    total += atScale(amount);
    if (total > ceiling) return false;
  }
  return true;
}

type CashFloor = { usd: number; assets: readonly string[] };
type Priced = Parameters<typeof tokenUsd>[1] & { asset_id: string };

/**
 * The floor's cash in USD: the public and confidential balance of its assets (`held`, raw units each), at fresh prices.
 * An asset held with no fresh price leaves it unknown; an asset not held counts nothing and needs no price.
 */
export function cashUsd(floor: CashFloor, held: Readonly<Record<string, string>>, tokens: readonly Priced[], now: number): number | null {
  let total = 0;
  for (const asset of floor.assets) {
    const raw = BigInt(held[asset] ?? "0");
    if (raw === 0n) continue;
    const usd = tokenUsd(raw, tokens.find((t) => t.asset_id === asset), now);
    if (usd === null) return null;
    total += usd;
  }
  return Number.isFinite(total) ? total : null;
}

/** What a swap does to the floor's cash, in USD: its output floor if it buys a named asset, less its input if it spends one. */
export const cashChange = (floor: CashFloor, swap: { from: string; to: string }, usdIn: number, usdOutFloor: number) =>
  (floor.assets.includes(swap.to) ? usdOutFloor : 0) - (floor.assets.includes(swap.from) ? usdIn : 0);

/**
 * Whether a swap breaks the floor: it lowers cash and leaves it under the floor. A swap that adds cash never does, even
 * while cash stays under the floor, since recovering it within the policy's caps takes several swaps. Equality holds.
 */
export const breaksCashFloor = (floor: CashFloor, cash: number, change: number) => change < 0 && cash + change < floor.usd;

/**
 * Whether a plan's swaps, taken in order at the observed book's prices, would break the cash floor: the same rule
 * `authorize` applies to each swap as it is sent, made before anything is claimed. Each swap counts its output floor; a
 * swap in an asset the book doesn't value breaks it, since it can't be counted.
 */
export function planBreaksCashFloor(floor: CashFloor, actions: readonly ({ type: "swap"; from: string; to: string; amount: string; minAmountOut: string } | { type: "shield" })[],
  book: readonly { asset: string; decimals: number; price: number; usd: number }[],
  /** Raw amounts of the floor's assets that sends held for the owner's vote would take, as `authorize` counts them. */
  committed: Readonly<Record<string, bigint>> = {}) {
  const of = (asset: string) => book.find((h) => h.asset === asset);
  let cash = floor.assets.reduce((sum, asset) => {
    const holding = of(asset);
    const held = committed[asset] ?? 0n;
    return sum + (holding?.usd ?? 0) - (holding && held > 0n ? usdValue(held.toString(), holding.decimals, holding.price) : 0);
  }, 0);
  for (const action of actions) {
    if (action.type !== "swap") continue;
    const from = of(action.from), to = of(action.to);
    if (!from || !to) return true;
    const change = cashChange(floor, action, usdValue(action.amount, from.decimals, from.price), usdValue(action.minAmountOut, to.decimals, to.price));
    if (breaksCashFloor(floor, cash, change)) return true;
    cash += change;
  }
  return false;
}
