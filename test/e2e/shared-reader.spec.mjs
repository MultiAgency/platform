import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext, connectWallet } from './wallet.mjs';
import { OWNER, PAYEE, SECOND, sign } from './provider.mjs';
import { payablesGeneration, signInAs, payeeApi } from './payables-steps.mjs';
import { quoteRegion, seedStrategy, signIn } from './treasury-journey.mjs';

// Shared readers: the app's agent belongs to a simulated Sputnik DAO whose council (OWNER: propose, vote, execute,
// manage) and member (SECOND: vote only) can both read it. SECOND signs in under the council's open tab (a real
// cookie switch). The apps notice only through their own triggers, so the window is measured, never tuned away.
// Oracle after the app reads the new identity: it shows SECOND, its controls match SECOND's permissions, and no answer
// to a request sent with the council's session lands. Shared agent records may stay visible to both.
const apps = JSON.parse(process.env.PROTO_E2E_OWNER_APPS ?? '{}');
const changes = JSON.parse(process.env.PROTO_E2E_OWNER_CHANGES ?? '{}');
const { change, has, CHANGES } = payablesGeneration();
const STALE_MS = 61_000; // the apps' gateway-identity staleness (60s), plus a second
/** The gateway session identity the page shows (Payables: "<account> Signed in"), as opposed to the wallet chip. */
const sessionIdentity = async page => (await page.getByText('Signed in', { exact: true }).locator('..').innerText({ timeout: 1_000 }).catch(() => '')).replace('Signed in', '').trim();

/** The tab is shown again after another tab switched the session. Headless Chromium keeps every page visible and fires
 * no visibilitychange on a tab switch, so the hide and show are emulated (bubbling, as a real one reaches window). */
const returnToTab = page => page.evaluate(async () => {
  for (const state of ['hidden', 'visible']) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});
/** A control's state, read without swallowing failures: absent, enabled or disabled. */
const controlState = async locator => (await locator.count()) === 0 ? 'absent' : (await locator.first().isEnabled()) ? 'enabled' : 'disabled';
const RETURN_MS = 5_000; // a returning tab reflects the switch within this (Payables session-recheck, Treasury session-revalidation)

/** Every agent read and identity read the page makes: when it was sent and answered, and under which session. */
function traffic(page, base) {
  const rows = [];
  page.on('requestfinished', async request => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith(`${base}/rpc/`) && path !== '/gw/me') return;
    const response = await request.response();
    // allHeaders(): headers() omits cookies, which would make every session comparison vacuous.
    rows.push({ path, sentWith: (await request.allHeaders()).cookie ?? '', at: Date.now(), status: response?.status(),
      viewer: path === '/gw/me' ? await response?.json().then(b => b.viewer?.account ?? null).catch(() => null) : undefined });
  });
  return rows;
}

for (const release of ['a', 'b']) test(`Payables shared readers, release ${release.toUpperCase()}: identity, permissions and answers follow an account switch`, async ({ browser }, info) => {
  test.skip(!apps.payables, 'Requires --payables-dist and --payables-dist-next');
  test.skip(!CHANGES.includes(change), `Requires --payables-change naming release B's change: ${CHANGES.join(' | ')}`);
  test.setTimeout(240_000);
  const stack = await environment(info.outputPath('environment'), { ownerApp: { product: 'payables', ...apps.payables }, daoOwned: true });
  const council = await browserContext(browser, stack, OWNER), payeeBrowser = await browserContext(browser, stack, PAYEE);
  const observed = { release, change: changes.payables };
  try {
    stack.release.activate(release);
    const page = await council.context.newPage(), other = await council.context.newPage();
    const rows = traffic(page, '/a/payout');
    await page.goto(`${stack.dashboard}/a/payout/`);
    await connectWallet(page, OWNER);
    await expect(page.getByText(OWNER).first()).toBeVisible();
    // A shared record: the council records an agreement; the contractor submits a report.
    const rpc = (method, input) => page.evaluate(async ({ method, input }) => (await (await fetch(`/a/payout/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) })).json()).json, { method, input });
    const agreementId = randomUUID();
    await rpc('compensation/agreement', { commandId: randomUUID(), id: agreementId, expectedVersion: 0, terms: { payee: PAYEE, title: 'Shared reader', document: 'https://example.test/a',
      signedOn: '2026-10-01', start: '2026-10-01', end: '2026-10-31', ceiling: '10000000', openingApproved: '0', scope: 'Shared reader' } });
    const payee = await payeeApi(await payeeBrowser.context.newPage(), stack);
    expect((await payee('POST', '/api/compensation', { commandId: randomUUID(), id: randomUUID(), expectedVersion: 0, submit: true,
      report: { agreementId, start: '2026-10-01', end: '2026-10-15', contributions: 'Shared work', assessment: 'Done', evidence: [] } })).status).toBe(200);
    await page.reload();
    const request = page.getByRole('button').filter({ hasText: PAYEE }).first();
    await request.click();
    // The council may review (execute); the member may not. Review needs an amount and feedback first.
    // Filled only where the form is shown (a member may see no review form); a shown field must accept input.
    const fillReview = async () => {
      for (const [label, value] of [['Compensation · USDC', '5'], ['Review feedback', 'Shared reader check']]) {
        const field = page.getByLabel(label, { exact: true });
        if (await field.isVisible()) await field.fill(value);
      }
    };
    await fillReview();
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeEnabled();
    const councilCookie = rows.findLast(r => r.path === '/gw/me')?.sentWith;

    // The switch: the member signs in under the open tab.
    await other.goto(`${stack.dashboard}/a/payout/`);
    await signInAs(other, SECOND, sign);
    const switched = Date.now();
    observed.immediately = { identity: await sessionIdentity(page), approve: await controlState(approve) };
    // The realistic trigger: the council's tab is shown again.
    await returnToTab(page);
    observed.onReturn = { reflectedMs: await expect.poll(async () => await sessionIdentity(page) === SECOND && await controlState(approve) !== 'enabled', { timeout: RETURN_MS })
      .toBe(true).then(() => Date.now() - switched, () => null), identity: await sessionIdentity(page), approve: await controlState(approve) };
    if (has(release, 'session-recheck'))
      expect(observed.onReturn.reflectedMs, `E2E_SHARED_READER_PROMPT: identity and Approve follow ${SECOND} within ${RETURN_MS}ms of the tab returning`).not.toBeNull();
    // The app's own trigger: identity data older than 60s, then a newly mounted reader (another Payables area).
    await page.waitForTimeout(STALE_MS);
    observed.beforeTrigger = { atMs: Date.now() - switched, identity: await sessionIdentity(page), approve: await controlState(approve) };
    await page.getByRole('link', { name: 'Agreements', exact: true }).click();
    await expect.poll(() => rows.some(r => r.path === '/gw/me' && r.at > switched && r.viewer === SECOND), { timeout: 20_000 }).toBe(true);
    const learned = rows.find(r => r.path === '/gw/me' && r.at > switched && r.viewer === SECOND).at;
    await page.getByRole('link', { name: 'Payments', exact: true }).click();
    await page.waitForTimeout(2_000);
    const reviewAfter = page.getByRole('button', { name: 'Approve', exact: true });
    // The same request is opened again and its panel is shown, so a missing or disabled Approve is the member's view.
    const requestAgain = page.getByRole('button').filter({ hasText: PAYEE }).first();
    await expect(requestAgain).toBeVisible();
    await requestAgain.click();
    await expect(page.getByText('Shared work').first(), 'the request panel is shown').toBeVisible();
    await fillReview();
    observed.afterTrigger = {
      learnedAfterMs: learned - switched,
      identity: await sessionIdentity(page),
      // The browser wallet's own connected account (unchanged: this switch happened through the gateway, not the wallet).
      walletChip: (await page.locator('header').first().innerText().catch(() => '')).includes(OWNER) ? OWNER : null,
      approve: await controlState(reviewAfter),
      councilAnswersAfterLearned: rows.filter(r => r.at > learned && r.sentWith === councilCookie && r.path !== '/gw/me').map(r => r.path),
      rereadsWithin2s: rows.filter(r => r.at > learned && r.at <= learned + 2_000 && r.path !== '/gw/me').map(r => r.path),
    };
    // Witness that the session comparisons are not vacuous: the council's and the member's cookies were both recorded.
    observed.sessionsSeen = new Set(rows.map(r => r.sentWith).filter(Boolean)).size;
    expect(observed.sessionsSeen, 'requests carry distinguishable sessions').toBeGreaterThanOrEqual(2);
    if (has(release, 'account-scoped-cache')) {
      expect(observed.afterTrigger.identity, 'E2E_SHARED_READER_IDENTITY').toBe(SECOND);
      expect(observed.afterTrigger.approve, 'E2E_SHARED_READER_PERMISSIONS: no enabled council-only control on the shown request').not.toBe('enabled');
      expect(observed.afterTrigger.councilAnswersAfterLearned, 'E2E_SHARED_READER_ANSWERS: no council-session answer lands').toEqual([]);
    }
  } finally {
    writeFileSync(info.outputPath('observed.json'), JSON.stringify(observed, null, 2));
    await council.context.close(); await payeeBrowser.context.close(); await stack.close();
  }
});

/** The Treasury generations, in treasury-migration.spec.mjs's order; `account-scoped-reads` (A4) re-reads instance and
 * strategy status under each account; `session-revalidation` (A5) re-reads the session when the tab is shown again and
 * offers no permission-dependent control until it is confirmed. Later generations (A6 `guided-run`, A7 `access-wait`) keep
 * both and are asserted by the migration spec. */
const TREASURY_CHANGES = ['unresolved-guidance', 'operations-read-time', 'account-scoped-reads', 'session-revalidation', 'guided-run', 'access-wait', 'send-block'];
const treasuryHas = (release, name) => TREASURY_CHANGES.indexOf(name) < TREASURY_CHANGES.indexOf(changes.treasury) || (release === 'b' && name === changes.treasury);

for (const release of ['a', 'b']) test(`Treasury shared readers, release ${release.toUpperCase()}: permissions and answers follow each account switch, including the return`, async ({ browser }, info) => {
  test.skip(!apps.treasury, 'Requires --treasury-dist and --treasury-dist-next');
  test.setTimeout(300_000);
  const stack = await environment(info.outputPath('environment'), { ownerApp: { product: 'treasury', ...apps.treasury }, daoOwned: true });
  const council = await browserContext(browser, stack, OWNER);
  const observed = { release, change: changes.treasury, switches: [] };
  try {
    stack.release.activate(release);
    seedStrategy(stack, 3000);
    const page = await council.context.newPage(), other = await council.context.newPage();
    council.context.setDefaultTimeout(20_000);
    const rows = traffic(page, '/a/portfolio');
    // In-app navigation (the router's own history handling), never a page load, which would reset every cache.
    const go = path => page.evaluate(to => { history.pushState({}, '', to); dispatchEvent(new PopStateEvent('popstate')); }, `/a/portfolio${path}`);
    // Instance identity is read only by the recovery view (setup failing), where no identity trigger reaches a permitted
    // member on this stack; it is recorded here, and asserted by Treasury's own browser suite. Normal state below.
    await page.goto(`${stack.dashboard}/a/portfolio/`);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
    await expect.poll(() => rows.some(r => r.path === '/gw/me' && r.viewer === OWNER)).toBe(true);
    observed.sessionIdentityShown = await sessionIdentity(page) || null; // a Treasury-only host shows only the wallet chip
    await other.goto(`${stack.dashboard}/a/portfolio/`);
    for (const account of [SECOND, OWNER]) {
      await signInAs(other, account, sign);
      const switched = Date.now();
      const preview = quoteRegion(page).getByRole('button', { name: 'Preview', exact: true });
      // Preview follows the account only where the quote form is shown: its state is read with the region visible.
      const previewIs = async () => { await expect(quoteRegion(page)).toBeVisible(); return controlState(preview); };
      const follows = state => account === OWNER ? state === 'enabled' : state !== 'enabled';
      const previewBefore = await previewIs();
      // The realistic trigger: the switch happened in another tab, and the council's tab is shown again.
      await returnToTab(page);
      const reflectedOnReturnMs = await expect.poll(async () => follows(await previewIs()), { timeout: RETURN_MS }).toBe(true)
        .then(() => Date.now() - switched, () => null);
      // The app's own trigger: identity data older than 60s, then a newly mounted identity reader (the activity
      // page's workspace list, `useSiblings`). The overview and automations pages reuse the shell's reader.
      await page.waitForTimeout(STALE_MS);
      const previewAtTrigger = await previewIs();
      await go('/activity');
      await expect.poll(() => rows.some(r => r.path === '/gw/me' && r.at > switched && r.viewer === account), { timeout: 20_000 }).toBe(true);
      const me = rows.find(r => r.path === '/gw/me' && r.at > switched && r.viewer === account);
      await go('/');
      await page.waitForTimeout(3_000);
      const others = rows.filter(r => r.path === '/gw/me' && r.viewer && r.viewer !== account).map(r => r.sentWith);
      const step = { account, reflectedOnReturnMs, learnedAfterMs: me.at - switched, previewBefore, previewAtTrigger, preview: await previewIs(),
        instanceUnderNewSession: rows.some(r => r.at > me.at && r.path.endsWith('/rpc/instance') && r.sentWith === me.sentWith),
        otherSessionAnswersAfterLearned: rows.filter(r => r.at > me.at && others.includes(r.sentWith) && r.path !== '/gw/me').map(r => r.path) };
      observed.switches.push(step);
      if (treasuryHas(release, 'session-revalidation'))
        expect(step.reflectedOnReturnMs, `E2E_SHARED_READER_PROMPT: Preview follows ${account} within ${RETURN_MS}ms of the tab returning`).not.toBeNull();
      if (treasuryHas(release, 'account-scoped-reads')) {
        expect(step.otherSessionAnswersAfterLearned, 'E2E_SHARED_READER_ANSWERS: no other-session answer lands').toEqual([]);
        expect(follows(step.preview), `E2E_SHARED_READER_PERMISSIONS: Preview follows propose permission (${step.preview})`).toBe(true);
      }
    }
    observed.sessionsSeen = new Set(rows.map(r => r.sentWith).filter(Boolean)).size;
    expect(observed.sessionsSeen, 'requests carry distinguishable sessions').toBeGreaterThanOrEqual(2);
    expect(stack.portfolio.swaps, 'nothing sent').toHaveLength(0);
  } finally {
    writeFileSync(info.outputPath('observed.json'), JSON.stringify(observed, null, 2));
    await council.context.close(); await stack.close();
  }
});
