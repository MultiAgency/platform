import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE, SECOND, sign } from './provider.mjs';
import { payablesGeneration, signInAs, payeeApi } from './payables-steps.mjs';
import { quoteRegion, seedStrategy, signIn } from './treasury-journey.mjs';

// Account switching and sign-out isolation in Payables' actual builds (post-checkpoint evidence). One extra account
// (SECOND, no agent of its own; the host allows self-service sessions) signs in under the owner's open tab, as a
// sign-in in another tab would. After the app learns of the switch, nothing of the owner's may render or be answered.
const apps = JSON.parse(process.env.PROTO_E2E_OWNER_APPS ?? '{}');
/** When a request was sent (epoch ms): a read already in flight when the session changed is answered under the old one. */
const sentAt = response => response.request().timing().startTime;
/** Clicks sign-out and answers when the gateway answered it: a read sent after that must find no session. */
async function signOutAnswered(page, click) {
  const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/gw/logout');
  await click();
  const timing = (await answered).request().timing();
  return timing.startTime + timing.responseEnd;
}
const { change, has, CHANGES } = payablesGeneration();

for (const release of ['a', 'b']) test(`Payables release ${release.toUpperCase()} (${change}): an account switch and a sign-out leave none of the previous account's records`, async ({ browser }, info) => {
  test.skip(!apps.payables, 'Requires --payables-dist and --payables-dist-next');
  test.skip(!CHANGES.includes(change), `Requires --payables-change naming release B's change: ${CHANGES.join(' | ')}`);
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { ownerApp: { product: 'payables', ...apps.payables }, secondAccount: true });
  const owner = await browserContext(browser, stack, OWNER), payeeBrowser = await browserContext(browser, stack, PAYEE);
  const observed = {};
  try {
    stack.release.activate(release);
    const page = await owner.context.newPage(), other = await owner.context.newPage();
    // Every owner-RPC answer this page receives, with the time it arrived.
    const answers = [];
    page.on('response', response => { const path = new URL(response.url()).pathname; if (/^\/a\/payout\/rpc\//.test(path)) answers.push({ at: Date.now(), sent: sentAt(response), path, status: response.status(), method: response.request().method() }); });
    await page.goto(`${stack.dashboard}/a/payout/`);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Reports & payment requests' })).toBeVisible();

    // The owner's records: an agreement and one submitted report.
    const rpc = (method, input) => page.evaluate(async ({ method, input }) => {
      const response = await fetch(`/a/payout/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
      return (await response.json()).json;
    }, { method, input });
    const agreementId = randomUUID();
    await rpc('compensation/agreement', { commandId: randomUUID(), id: agreementId, expectedVersion: 0, terms: { payee: PAYEE, title: 'Switch test', document: 'https://example.test/a',
      signedOn: '2026-10-01', start: '2026-10-01', end: '2026-10-31', ceiling: '10000000', openingApproved: '0', scope: 'Switch test' } });
    const payee = await payeeApi(await payeeBrowser.context.newPage(), stack);
    const requestId = randomUUID();
    expect((await payee('POST', '/api/compensation', { commandId: randomUUID(), id: requestId, expectedVersion: 0, submit: true,
      report: { agreementId, start: '2026-10-01', end: '2026-10-15', contributions: 'Switch test work', assessment: 'Done', evidence: [] } })).status).toBe(200);
    await page.reload();
    const ownersRequest = page.getByRole('button').filter({ hasText: PAYEE });
    await expect(ownersRequest.first()).toBeVisible();
    await ownersRequest.first().click();
    await page.getByLabel('Review feedback', { exact: true }).fill('Declined during an account switch');

    // Another account signs in under the open tab. The owner's next action is refused by the gateway.
    await other.goto(`${stack.dashboard}/a/payout/`);
    await signInAs(other, SECOND, sign);
    const switched = Date.now();
    await page.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect.poll(() => answers.filter(a => a.at >= switched && a.path.endsWith('/compensation/review')).length).toBe(1);
    await page.waitForTimeout(3_000);
    observed.switch = { stillRendered: await ownersRequest.count(), reviews: answers.filter(a => a.path.endsWith('/compensation/review')).map(a => a.status),
      answeredAfterSwitch: answers.filter(a => a.at >= switched && a.status === 200).map(a => a.path) };
    const record = (await payee('GET', '/api/compensation')).body.requests.find(r => r.id === requestId);
    expect(record.state, 'the refused review changed nothing').toBe('submitted');
    // The gateway refuses the owner's action under the new session in every generation.
    expect(observed.switch.reviews, 'the review was sent once and refused').toEqual([403]);
    if (has(release, 'account-scoped-cache')) {
      await expect(ownersRequest, 'E2E_NO_PREVIOUS_ACCOUNT_RECORDS').toHaveCount(0);
      expect(observed.switch.answeredAfterSwitch, 'no owner read is answered under the new account').toEqual([]);
    } else {
      // A generation before account-scoped-cache: what it still shows of the previous account is recorded as a finding.
      test.info().annotations.push({ type: 'observed-leak', description: `release ${release.toUpperCase()} without account-scoped-cache: ${observed.switch.stillRendered} previous-account record(s) rendered, ${observed.switch.answeredAfterSwitch.length} owner read(s) answered after the switch` });
    }

    // Sign-out clears: the owner signs in again, sees the records, signs out, and nothing remains or is answered.
    await signInAs(other, OWNER, sign);
    await page.goto(`${stack.dashboard}/a/payout/`);
    await expect(page.getByRole('heading', { name: 'Reports & payment requests' })).toBeVisible();
    await expect(ownersRequest.first()).toBeVisible();
    const signedOut = await signOutAnswered(page, () => page.getByRole('button', { name: 'Sign out' }).click());
    await page.waitForTimeout(3_000);
    observed.signOut = { stillRendered: await ownersRequest.count(), answeredAfterSignOut: answers.filter(a => a.sent >= signedOut && a.status === 200).map(a => a.path) };
    await expect(ownersRequest, 'E2E_SIGN_OUT_CLEARS').toHaveCount(0);
    expect(observed.signOut.answeredAfterSignOut, 'no owner read is answered after sign-out').toEqual([]);
  } finally {
    writeFileSync(info.outputPath('observed.json'), JSON.stringify({ release, change, ...observed }, null, 2));
    await owner.context.close(); await payeeBrowser.context.close(); await stack.close();
  }
});

// Treasury: the portfolio agent belongs to PAYEE; SECOND signs in under the open tab.
const treasuryChange = JSON.parse(process.env.PROTO_E2E_OWNER_CHANGES ?? '{}').treasury;
for (const release of ['a', 'b']) test(`Treasury migrated release ${release.toUpperCase()} (${treasuryChange}): an account switch and a sign-out leave none of the previous account's records`, async ({ browser }, info) => {
  test.skip(!apps.treasury, 'Requires --treasury-dist and --treasury-dist-next');
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { workspace: true, ownerApp: { product: 'treasury', ...apps.treasury }, secondAccount: true });
  const owner = await browserContext(browser, stack, PAYEE);
  const observed = {};
  try {
    stack.release.activate(release);
    seedStrategy(stack, 3000);
    const page = await owner.context.newPage(), other = await owner.context.newPage();
    const answers = [];
    page.on('response', response => { const path = new URL(response.url()).pathname; if (/^\/a\/portfolio\/rpc\//.test(path)) answers.push({ at: Date.now(), sent: sentAt(response), path, status: response.status() }); });
    await signIn(page, stack);
    // The owner's record on screen: the saved strategy's targets.
    const ownersStrategy = quoteRegion(page).getByText(/30% wNEAR \/ 70% USDC/);
    await expect(ownersStrategy).toBeVisible({ timeout: 30_000 });
    await other.goto(`${stack.dashboard}/a/portfolio/`);
    await signInAs(other, SECOND, sign);
    const switched = Date.now();
    await quoteRegion(page).getByRole('button', { name: 'Preview', exact: true }).click();
    await page.waitForTimeout(3_000);
    observed.switch = { stillRendered: await ownersStrategy.count(), afterSwitch: answers.filter(a => a.at >= switched).map(a => `${a.status} ${a.path}`) };
    await expect(ownersStrategy, 'E2E_NO_PREVIOUS_ACCOUNT_RECORDS').toHaveCount(0);
    expect(answers.filter(a => a.sent >= switched && a.status === 200).map(a => a.path), 'no owner read sent under the new account is answered').toEqual([]);
    expect(stack.portfolio.swaps, 'nothing sent').toHaveLength(0);
    await signInAs(other, PAYEE, sign);
    await page.goto(`${stack.dashboard}/a/portfolio/`);
    await expect(ownersStrategy).toBeVisible({ timeout: 30_000 });
    // Treasury's sign-out is the wallet menu's "Disconnect" (it posts /gw/logout for a signed-in viewer).
    await page.getByRole('button', { name: /^Wallet: / }).click();
    const signedOut = await signOutAnswered(page, () => page.getByRole('menuitem', { name: 'Disconnect' }).click({ timeout: 15_000 }));
    await page.waitForTimeout(3_000);
    observed.signOut = { stillRendered: await ownersStrategy.count(), afterSignOut: answers.filter(a => a.sent >= signedOut).map(a => `${a.status} ${a.path}`) };
    await expect(ownersStrategy, 'E2E_SIGN_OUT_CLEARS').toHaveCount(0);
    expect(answers.filter(a => a.sent >= signedOut && a.status === 200).map(a => a.path), 'no owner read sent after sign-out is answered').toEqual([]);
  } finally {
    writeFileSync(info.outputPath('observed.json'), JSON.stringify({ product: 'treasury', release, change: treasuryChange, ...observed }, null, 2));
    await owner.context.close(); await stack.close();
  }
});
