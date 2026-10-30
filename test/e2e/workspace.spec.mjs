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
async function signedPage(browser, stack, account, path) {
  const wallet = await browserContext(browser, stack, account);
  await wallet.context.tracing.start({ screenshots: true, snapshots: true });
  const page = await wallet.context.newPage();
  await page.goto(`${stack.dashboard}${path}`);
  await connectWallet(page, account);
  return { ...wallet, page };
}
async function scenario(browser, info, run, options = {}) {
  const stack = await environment(info.outputPath('environment'), { workspace: true, ...options });
  stack.browserVersion = browser.version();
  const wallets = [];
  try { await run(stack, async (account, path) => { const wallet = await signedPage(browser, stack, account, path); wallets.push(wallet); return wallet; }); }
  finally {
    for (const [i, wallet] of wallets.entries()) {
      await wallet.page.screenshot({ path: info.outputPath(`${i}.png`), fullPage: true }).catch(() => {});
      writeFileSync(info.outputPath(`${i}.txt`), await wallet.page.locator('body').innerText().catch(() => 'unavailable'));
      await wallet.context.tracing.stop({ path: info.outputPath(`trace-${i}.zip`) });
      await wallet.context.close();
    }
    await stack.close();
    expect(stack.simulated.errors).toEqual([]); expect(stack.portfolio.errors).toEqual([]);
    for (const wallet of wallets) expect(wallet.unexpected).toEqual([]);
  }
}

test('cross-agent navigation keeps identity and gateway permissions isolated', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const { page } = await login(OWNER, '/');
    await expect(page.getByRole('heading', { name: 'Your agents', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Walkthroughs for payout', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payables agent', exact: true })).toBeVisible();
    expect((await rpc(page, 'payout', 'instance')).body.json.agentId).toBe(stack.simulated.id);
    // Agent links cause a document navigation, resetting client/cache ownership.
    await page.evaluate(() => { window.__candidateDocument = 'payout'; });
    await page.getByRole('link', { name: '← All agents', exact: true }).click();
    await page.getByRole('link', { name: 'Walkthroughs for portfolio', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Treasury agent', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__candidateDocument)).toBeUndefined();
    expect((await rpc(page, 'portfolio', 'instance')).body.json.agentId).toBe(stack.portfolio.id);
    await page.goBack(); await page.goBack();
    await expect(page.getByRole('heading', { name: 'Payables agent', exact: true })).toBeVisible();
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
    const restricted = await login(PAYEE, '/a/portfolio/automations');
    const me = await restricted.page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(Object.keys(me.viewer.access)).toEqual(['portfolio']);
    expect(me.agents.map(a => a.name)).toEqual(['portfolio']);
    expect((await rpc(restricted.page, 'payout', 'instance')).status).toBe(403);
    expect((await rpc(restricted.page, 'payout', 'autopilot/stop')).status).toBe(403);
    await restricted.page.goto(`${stack.dashboard}/a/payout/`);
    await expect(restricted.page.getByRole('heading', { name: 'Payments', exact: true })).toHaveCount(0);
    expect(stack.simulated.intents).toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toBeNull();
  });
});

// The strategy screens are Treasury's; this journey runs against its release A (`--treasury-dist`).
const apps = JSON.parse(process.env.PROTO_E2E_OWNER_APPS ?? '{}');
test('strategy saves off, authorizes, rejects stale review, enables explicitly and stops during provider failure', async ({ browser }, info) => {
  test.skip(!apps.treasury, 'The strategy screens require --treasury-dist and --treasury-dist-next');
  await scenario(browser, info, async (stack, login) => {
    const { page, signatures } = await login(PAYEE, '/a/portfolio/automations');
    await expect(page.getByRole('heading', { name: 'Strategy', exact: true })).toBeVisible();
    const original = (await rpc(page, 'portfolio', 'strategy/get')).body.json;
    await page.getByRole('button', { name: 'Edit strategy', exact: true }).click();
    await page.getByLabel('USDC (%)', { exact: true }).fill('60');
    await page.getByLabel('wNEAR (%)', { exact: true }).fill('20');
    await page.getByLabel('ETH (%)', { exact: true }).fill('20');
    await page.getByLabel('Run every (minutes)', { exact: true }).fill('120');
    await page.getByRole('button', { name: 'Save with autopilot off', exact: true }).click();
    await expect.poll(() => stack.portfolioState().strategy?.autopilot.everyMin).toBe(120);
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    expect(stack.portfolio.intents).toHaveLength(0);
    const saved = (await rpc(page, 'portfolio', 'strategy/get')).body.json;
    expect(saved.digest).not.toBe(original.digest);
    // An old tab cannot overwrite, authorize, or enable the newly saved strategy.
    for (const [method, input] of [
      ['strategy/save', { strategy: original.strategy, expectedDigest: original.digest }],
      ['owner/prepare', { action: { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: original.digest } }],
      ['autopilot/enable', { expectedDigest: original.digest }],
    ]) expect((await rpc(page, 'portfolio', method, input)).status).toBeGreaterThanOrEqual(400);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toEqual(saved.strategy);
    await expect(page.getByRole('heading', { name: 'Authorize this saved strategy', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Authorize in wallet', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible();
    expect(stack.portfolio.intents).toHaveLength(1);
    expect(stack.portfolio.grants.at(-1).label).toBe(`treasury:${saved.digest.slice(7, 39)}`);
    expect(signatures.filter(s => s.recipient === 'local-provider')).toHaveLength(1);
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect.poll(() => stack.portfolioState().settings).toMatch(/AUTOPILOT=on\n/);
    stack.portfolio.setUnavailable(true);
    // Establish a real provider failure before using the provider-independent stop control.
    expect((await rpc(page, 'portfolio', 'overview')).status).toBeGreaterThanOrEqual(400);
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect.poll(() => stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    expect((await rpc(page, 'portfolio', 'autopilot/get')).body.json.on).toBe(false);
    await page.reload();
    expect((await rpc(page, 'portfolio', 'autopilot/get')).body.json.on).toBe(false);
    expect(stack.portfolio.transfers).toHaveLength(0);
    expect(stack.portfolio.requests.filter(r => r.method === 'POST' && r.path !== '/chain').map(r => r.path)).toEqual(['/v1/generate-intent', '/v1/submit-intent']);
  }, { ownerApp: { product: 'treasury', ...apps.treasury } });
});
