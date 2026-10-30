import { expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAYEE, USDC } from './provider.mjs';
import { connectWallet } from './wallet.mjs';

// Shared steps of Treasury's own interface on the real stack.

/** The portfolio agent's saved strategy: three assets, a rebalance leg from USDC toward `wrapBps` of wNEAR. */
export function seedStrategy(stack, wrapBps = 2500) {
  const strategy = join(stack.directory, 'portfolio/.strategy'); mkdirSync(strategy, { recursive: true });
  writeFileSync(join(strategy, '.env.json'), JSON.stringify({ targetBps: { [USDC]: 10_000 - wrapBps, 'nep141:wrap.near': wrapBps, 'nep141:eth.omft.near': 0 }, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 0 } }));
}

/** The owner signs in once through Treasury's interface. */
export async function signIn(page, stack) {
  await page.goto(`${stack.dashboard}/a/portfolio/`);
  await connectWallet(page, PAYEE);
}

export const quoteRegion = page => page.getByRole('region', { name: 'Quoted rebalance', exact: true });
export const outcomeRegion = page => page.getByRole('region', { name: 'Confirmed plan outcome' });

/** Preview a rebalance quote, open the confirmation (which sends nothing) and confirm "Execute swaps" once. */
export async function previewAndExecute(page, executions) {
  const quote = quoteRegion(page), before = executions();
  await quote.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(quote.getByText(/Estimated received/).first()).toBeVisible({ timeout: 30_000 });
  await expect(quote.getByText(/Minimum received/).first()).toBeVisible();
  await expect(quote.getByText(/Valid until/).first()).toBeVisible();
  expect(executions()).toBe(before);
  await quote.getByRole('button', { name: 'Execute', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Execute the previewed rebalance on mainnet?' });
  await expect(confirm.getByRole('region', { name: 'Saved plan summary' })).toBeVisible();
  expect(executions(), 'opening the confirmation sends nothing').toBe(before);
  await confirm.getByRole('button', { name: 'Execute swaps', exact: true }).click();
}
