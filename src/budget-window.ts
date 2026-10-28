/** The USD budget's three windows, as the provider reports each: its limit (null: unlimited) and what is left. Pure, shared with the web. */
type Window = { limit_usd: string | null; remaining_usd: string | null };

/** The USD budget window that refuses first: the limited one with the least left, as the provider checks every window. */
export function bindingWindow<W extends Window>(budget: Record<"daily" | "weekly" | "monthly", W>) {
  return (["daily", "weekly", "monthly"] as const)
    .map((period) => ({ period, ...budget[period] }))
    .filter((w) => w.limit_usd !== null)
    .sort((a, b) => Number(a.remaining_usd ?? Infinity) - Number(b.remaining_usd ?? Infinity))[0];
}

/**
 * The provider's policy view with an uncapped window's spend as owner clients read it. Since the provider's API #51
 * (2026-10-27, SDK 0.7.2) an uncapped window reports `spent_usd: null`: nothing is counted against a cap that doesn't
 * exist. Until then it reported "0.000000", which is what clients built on earlier SDKs still require, so the overview
 * keeps that value. A null spend under a limit is passed on as it is, for the overview's schema to refuse.
 */
type ProviderWindow = { limit_usd: string | null; spent_usd: string | null; remaining_usd: string | null; resets_at: string | null };
type Budget<W> = Record<"daily" | "weekly" | "monthly", W>;
export function countedSpend<V extends { usage: { budget: Budget<ProviderWindow> } }>(view: V) {
  const budget = Object.fromEntries(Object.entries(view.usage.budget).map(([period, window]) =>
    [period, window.spent_usd === null && window.limit_usd === null ? { ...window, spent_usd: "0.000000" } : window]));
  return { ...view, usage: { ...view.usage, budget: budget as Budget<ProviderWindow & { spent_usd: string }> } };
}
