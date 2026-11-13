import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext, connectWallet } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';

async function rpc(page, agent, method, input) {
  return page.evaluate(async ({ agent, method, input }) => {
    const response = await fetch(`/a/${agent}/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
    return { status: response.status, body: await response.json() };
  }, { agent, method, input });
}
// The running test's wallets, each recorded as soon as it has a page. A test stalled on an await that is not a
// Playwright call times out without reaching its `finally`; the after-each hook still runs, and saves them.
const openWallets = [];
async function saveWallets(info) {
  const wallets = openWallets.splice(0);
  for (const [i, wallet] of wallets.entries()) {
    await wallet.page.screenshot({ path: info.outputPath(`${i}.png`), fullPage: true }).catch(() => {});
    writeFileSync(info.outputPath(`${i}.txt`), await wallet.page.locator('body').innerText().catch(() => 'unavailable'));
    await wallet.context.tracing.stop({ path: info.outputPath(`trace-${i}.zip`) });
    await wallet.context.close();
  }
  return wallets;
}
test.afterEach(async ({}, info) => { await saveWallets(info); });
async function signedPage(browser, stack, account, path) {
  const wallet = await browserContext(browser, stack, account);
  await wallet.context.tracing.start({ screenshots: true, snapshots: true });
  const signed = { ...wallet, page: await wallet.context.newPage() };
  openWallets.push(signed);
  await signed.page.goto(`${stack.dashboard}${path}`);
  await connectWallet(signed.page, account);
  return signed;
}
async function scenario(browser, info, run, options = {}) {
  const stack = await environment(info.outputPath('environment'), { workspace: true, ...options });
  stack.browserVersion = browser.version();
  let wallets = [];
  try { await run(stack, (account, path) => signedPage(browser, stack, account, path)); }
  finally {
    wallets = await saveWallets(info);
    await stack.close();
    expect(stack.simulated.errors).toEqual([]); expect(stack.portfolio.errors).toEqual([]);
    for (const wallet of wallets) expect(wallet.unexpected).toEqual([]);
  }
}

test('one session reaches each of its agents under the identity of that agent', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const { page } = await login(OWNER, '/');
    expect(Object.keys((await page.evaluate(async () => (await fetch('/gw/me')).json())).viewer.access).sort()).toEqual(['payout', 'portfolio']);
    expect((await rpc(page, 'payout', 'instance')).body.json.agentId).toBe(stack.simulated.id);
    expect((await rpc(page, 'portfolio', 'instance')).body.json.agentId).toBe(stack.portfolio.id);
    // Going back to the first agent answers as that agent again: nothing carries over from the other's calls.
    expect((await rpc(page, 'payout', 'instance')).body.json.agentId).toBe(stack.simulated.id);
    expect(stack.simulated.intents).toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toBeNull();
  }, { portfolioOwner: OWNER });
});

test('each wallet sees only its own agents despite legacy operator configuration', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const owner = await login(OWNER, '/a/payout/');
    const ownerView = await owner.page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(Object.keys(ownerView.viewer.access)).toEqual(['payout']);
    expect(ownerView.viewer.access.payout).toEqual({ canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true });
    expect((await rpc(owner.page, 'portfolio', 'instance')).status).toBe(403);
    expect((await rpc(owner.page, 'portfolio', 'autopilot/stop')).status).toBe(403);
    const restricted = await login(PAYEE, '/a/portfolio/');
    const me = await restricted.page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(Object.keys(me.viewer.access)).toEqual(['portfolio']);
    expect(me.agents.map(a => a.name)).toEqual(['portfolio']);
    expect((await rpc(restricted.page, 'payout', 'instance')).status).toBe(403);
    expect((await rpc(restricted.page, 'payout', 'autopilot/stop')).status).toBe(403);
    expect(stack.simulated.intents).toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toBeNull();
  });
});
