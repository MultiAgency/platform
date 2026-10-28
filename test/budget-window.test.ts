import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { api } from "../src/api.js";
import { bindingWindow, countedSpend } from "../src/budget-window.js";
import { budgetRemaining } from "../src/holdings.js";

/** A plan shows the budget the provider refuses at first: the limited window with the least left. */

const window = (limit: string | null, remaining: string | null) => ({ limit_usd: limit, remaining_usd: remaining, spent_usd: "0", resets_at: null });

test("the window with the least left binds, and an unlimited one never does", () => {
  const budget = { daily: window("25", "4.50"), weekly: window("75", "40"), monthly: window(null, null) };
  assert.equal(bindingWindow(budget)?.period, "daily");
  assert.equal(bindingWindow({ ...budget, daily: window(null, null) })?.period, "weekly");
  assert.equal(bindingWindow({ daily: window(null, null), weekly: window(null, null), monthly: window(null, null) }), undefined);
});

test("a plan's budget is the binding window's, not the monthly one's", async () => {
  mock.method(api, "getPolicy", async () => ({ usage: { budget: { daily: window("25", "4.50"), weekly: window("75", "40"), monthly: window("150", "90") } } }));
  assert.equal(await budgetRemaining(), "4.50");
  mock.method(api, "getPolicy", async () => ({ usage: { budget: { daily: window(null, null), weekly: window(null, null), monthly: window(null, null) } } }));
  assert.equal(await budgetRemaining(), null);
  mock.restoreAll();
});

test("an uncapped window's spend reads as the provider reported it before its API #51; anything else passes through", () => {
  const window = (limit_usd: string | null, spent_usd: string | null) => ({ limit_usd, spent_usd, remaining_usd: limit_usd, resets_at: null });
  const view = { revision: 1, usage: { budget: { daily: window("50.00", "1.50"), weekly: window(null, null), monthly: window("200.00", null) }, timelock: { delay_ms: 0 } } };
  const counted = countedSpend(view);
  assert.deepEqual(counted.usage.budget.weekly, { limit_usd: null, spent_usd: "0.000000", remaining_usd: null, resets_at: null });
  assert.deepEqual(counted.usage.budget.daily, view.usage.budget.daily);
  assert.equal(counted.usage.budget.monthly.spent_usd, null, "a null spend under a limit isn't made up; the overview's schema refuses it");
  assert.deepEqual(counted.usage.timelock, { delay_ms: 0 });
  assert.equal(view.usage.budget.weekly.spent_usd, null, "the provider's view is not changed");
});
