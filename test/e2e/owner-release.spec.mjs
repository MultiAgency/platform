import { test as base, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';
import { ownerCapabilities } from '../../src/contract/owner-capabilities.ts';
import { recordConformance } from './conformance.mjs';
import { payablesGeneration, payeeApi } from './payables-steps.mjs';

// P2: an owner app's actual builds, released independently behind the gateway. Release IDs are the build digests.
// Owner steps use the app's own interface and the test wallet (real NEP-413 signatures, unfunded key); the
// payee uses the payee API; provider, deposits and settlement are simulated.
const apps = JSON.parse(process.env.PROTO_E2E_OWNER_APPS ?? '{}');
const capabilityOf = procedure => Object.entries(ownerCapabilities).filter(([, c]) => c.procedures.includes(procedure)).map(([name]) => name);
const portfolioOnly = ['treasury-observe-v1', 'treasury-strategy-v1', 'treasury-plans-v1', 'treasury-recovery-v1'];
const { change, has, CHANGES } = payablesGeneration();

const test = base.extend({
  stack: async ({}, use, info) => {
    const stack = await environment(info.outputPath('environment'), apps.payables ? { ownerApp: { product: 'payables', ...apps.payables } } : {});
    try { await use(stack); }
    finally { await stack.close(); expect(stack.simulated.errors).toEqual([]); }
  },
  people: async ({ browser, stack }, use, info) => {
    const owner = await browserContext(browser, stack, OWNER), payee = await browserContext(browser, stack, PAYEE);
    for (const { context } of [owner, payee]) context.setDefaultTimeout(15_000);
    try { await use({ owner, payee, page: await owner.context.newPage(), payeePage: await payee.context.newPage() }); }
    finally {
      for (const [i, { context, unexpected }] of [owner, payee].entries()) {
        for (const [n, page] of context.pages().entries()) {
          await page.screenshot({ path: info.outputPath(`${i}-${n}.png`) }).catch(() => {});
          writeFileSync(info.outputPath(`${i}-${n}.txt`), await page.locator('body').innerText().catch(() => 'Page unavailable'));
        }
        await context.close(); expect(unexpected).toEqual([]);
      }
    }
  },
});

/** RPC procedures the owner's pages requested, classified by the capability map, so the assertion follows the map. */
const requestedCapabilities = requests => new Set(requests.map(r => new URL(r.url).pathname.match(/^\/a\/[a-z0-9-]+\/rpc\/(.+)$/)?.[1]).filter(Boolean).flatMap(capabilityOf));

/** An owner action through the app's confirm dialog; the test wallet signs the prepared intent once. */
async function confirmAction(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog').or(page.getByRole('alertdialog')).getByRole('button', { name, exact: true }).click();
}

test.skip(!apps.payables, 'Requires --payables-dist and --payables-dist-next');
test.skip(!CHANGES.includes(change), `Requires --payables-change naming release B's change: ${CHANGES.join(' | ')}`);
test('Payables report to payment across independent releases A, B, refused C and rollback, without restarting Proto', async ({ stack, people }, info) => {
  const { release } = stack, { page } = people, conformance = recordConformance(page), proto = stack.protoPids(), signatures = () => people.owner.signatures.length;
  expect(release.env, 'the release process holds no Proto configuration or credentials').toEqual({ HOST: '127.0.0.1', PORT: expect.any(String), RELEASES_ROOT: release.root });
  await conformance.ready;
  const served = () => page.evaluate(async () => (await fetch('/a/payout/', { cache: 'no-store' })).text());
  const html = name => readFileSync(join(release.root, release.ids[name], 'index.html'), 'utf8');
  expect(html('b'), 'release B must differ from A').not.toBe(html('a'));
  const skillMatches = async name => {
    const file = JSON.parse(readFileSync(join(release.root, release.ids[name], 'contract.json'), 'utf8')).entries['/skill.md'];
    const answer = await page.evaluate(async () => { const r = await fetch('/skill.md', { cache: 'no-store' }); return { status: r.status, body: await r.text() }; });
    expect(answer.status).toBe(file ? 200 : 404);
    if (file) expect(answer.body).toBe(readFileSync(join(release.root, release.ids[name], file), 'utf8'));
  };
  // P2's B change: the review queue states how many reports await review.
  const reviewCount = page.getByText(/^Awaiting your review: \d+$/);
  const expectReviewCount = async (release, text = /^Awaiting your review: \d+$/) =>
    has(release, 'review-count') ? expect(reviewCount).toHaveText(text) : expect(reviewCount).toHaveCount(0);
  /** A5 (with SDK 0.1.0's shared/isolated choice) names the isolated preparation; earlier releases call it "Pay". */
  const prepareIsolated = release => page.getByRole('button', { name: has(release, 'record-deep-link') ? 'Prepare isolated order' : 'Pay', exact: true });
  /** B2's change: a refused compensation step says nothing changed and re-reads; without it, only the server's refusal. */
  const refusedPreparation = async release => {
    await page.getByLabel('Isolated order payment deadline (UTC)', { exact: true }).fill(new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 16));
    await prepareIsolated(release).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Prepare payout', exact: true }).click();
    await expect(page.getByText('Choose a future payment deadline within 365 days.').first()).toBeVisible();
    const nothingChanged = page.getByText('Nothing was changed or sent.');
    if (has(release, 'compensation-recovery')) await expect(nothingChanged.first()).toBeVisible(); else await expect(nothingChanged).toHaveCount(0);
    expect(stack.simulated.created(), 'a refused preparation creates no order agent').toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
  };
  /** A5's change: /?request=<id> opens that request with its report; earlier releases ignore the parameter. Reads only. */
  const expectDeepLink = async (release, requestId, contributions) => {
    await page.goto(`${stack.dashboard}/a/payout/?request=${requestId}`);
    await expect(page.getByRole('heading', { name: 'Reports & payment requests' })).toBeVisible();
    const selected = page.getByRole('button', { name: new RegExp(PAYEE.replaceAll('.', '\\.')), pressed: true });
    if (has(release, 'record-deep-link')) {
      await expect(page.getByText(contributions).first()).toBeVisible();
      await expect(selected.first()).toBeVisible();
    } else {
      await expect(page.getByText('Evidence before execution.').first()).toBeVisible();
      await expect(page.getByText(contributions)).toHaveCount(0);
      await expect(selected).toHaveCount(0);
    }
    await page.goto(`${stack.dashboard}/a/payout/`);
  };
  /** A6's change: each agreement offers its contributor report link, resolved beside the payee entry (the stack gives
   * production's `…/submit` shape) to a page the payee host serves; earlier releases offer no report link. */
  const expectReportLink = async (release, agreementId) => {
    await page.goto(`${stack.dashboard}/a/payout/payees`);
    await expect(page.getByRole('heading', { name: 'October design support', level: 3 })).toBeVisible();
    const link = page.getByRole('link', { name: 'Open report form', exact: true });
    if (has(release, 'report-link')) {
      await expect(link).toHaveAttribute('href', `${stack.invoices}/report?agreement=${agreementId}`);
      expect((await people.payeePage.goto(await link.getAttribute('href')))?.status(), 'the payee host serves the report link').toBe(200);
    } else await expect(link).toHaveCount(0);
    await page.goto(`${stack.dashboard}/a/payout/`);
  };
  /**
   * A7's change (`owner-attention`): the queue names each request's next owner step and counts those needing action,
   * selecting a request is kept in the address (replacing, so Back leaves the page), the card shows the agreement's scope
   * and other requests, and the review amount starts from the report's own amount, never the remaining ceiling. Before
   * A7 none of this text appears and selection leaves the address alone. Reads only.
   */
  const needsAction = page.getByText(/^Needs your action: \d+$/);
  const queueItem = () => page.getByRole('list', { name: 'Requests' }).getByRole('listitem').filter({ hasText: PAYEE });
  const LANDING_HELD = 'No alerts in this agent\'s payout records. 1 request needs your action below.';
  const LANDING_CLEAR = 'No payout or setup alerts in the records checked. Review reports & payment requests below.';
  const expectAttention = async (release, { step, count, landing }) => {
    if (landing) await page.goto(`${stack.dashboard}/a/payout/`);
    if (!has(release, 'owner-attention')) { await expect(needsAction).toHaveCount(0); return; }
    await expect(needsAction).toHaveText(`Needs your action: ${count}`);
    await expect(queueItem().first()).toContainText(step);
    if (landing) await expect(page.getByText(landing, { exact: true })).toBeVisible();
  };
  /** The report in review on A7: counts, step, the kept selection across reload, scope, other requests and the amount. */
  const expectReviewAttention = async (requestId, contributions) => {
    await page.goto(`${stack.dashboard}/a/payout/payees`);
    await page.goto(`${stack.dashboard}/a/payout/`);
    await expect(page.getByText('Awaiting your review: 1', { exact: true })).toBeVisible();
    await expectAttention('b', { step: 'Review the work', count: 1 });
    await page.getByRole('button').filter({ hasText: PAYEE }).filter({ hasText: 'In review' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('request')).toBe(requestId);
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(PAYEE.replaceAll('.', '\\.')), pressed: true }).first()).toBeVisible();
    await expect(page.getByText(contributions).first()).toBeVisible();
    await expect(page.getByText('Scope reference', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Design reviews for onboarding', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Other requests on this agreement', level: 3 })).toBeVisible();
    await expect(page.getByText('None recorded.', { exact: true }).first()).toBeVisible();
    // An amount-free report leaves the review amount empty: never the remaining ceiling (40).
    await expect(page.getByLabel('Compensation · USDC', { exact: true })).toHaveValue('');
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname, 'Back leaves the page; selections are replaced').not.toBe('/a/payout/');
  };
  const chunksOf = text => text.match(/\/static\/(js|css)\/[a-zA-Z0-9_.-]+\.[a-f0-9]{8,}\.(js|css)/g) ?? [];

  // 1. Release A serves the owner interface from its own process; the owner signs in once.
  await page.goto(`${stack.dashboard}/a/payout/`);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Reports & payment requests' })).toBeVisible();
  expect(await served()).toBe(html('a'));
  await skillMatches('a');
  await expectReviewCount('a');
  const me = await page.evaluate(async () => (await fetch('/gw/me')).json());
  expect(me.capabilities).toContain('agent-schedule-stop-v1');
  expect(me.capabilities.filter(c => c.startsWith('treasury-'))).toEqual([]);
  const aChunks = chunksOf(html('a'));
  expect(aChunks.length).toBeGreaterThan(0);

  // 2. Agreement recorded in the owner interface.
  await page.goto(`${stack.dashboard}/a/payout/payees`);
  await page.getByText('Record a signed agreement', { exact: true }).click();
  for (const [label, value] of [['Agreement title', 'October design support'], ['Contributor NEAR account', PAYEE], ['Signed Google Doc or document URL', 'https://example.test/agreement'],
    ['Signed on', '2026-10-01'], ['Work period starts', '2026-10-01'], ['Work period ends', '2026-10-31'], ['Upper limit · USDC', '40'], ['Already approved outside this system · USDC', '0']])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Scope reference', { exact: true }).fill('Design reviews for onboarding');
  await page.getByRole('button', { name: 'Record signed terms', exact: true }).click();
  await expect(page.getByText('40 of 40 USDC remaining')).toBeVisible();

  // 3. The payee submits a report; the owner sees it in review.
  const payee = await payeeApi(people.payeePage, stack);
  const agreementId = (await payee('GET', '/api/compensation')).body.agreements[0].id, requestId = globalThis.crypto.randomUUID();
  const report = await payee('POST', '/api/compensation', { commandId: globalThis.crypto.randomUUID(), id: requestId, expectedVersion: 0, submit: true,
    report: { agreementId, start: '2026-10-01', end: '2026-10-15', contributions: 'Reviewed onboarding screens', assessment: 'Delivered on schedule', evidence: [] } });
  expect(report.status).toBe(200);
  await expectReportLink('a', agreementId);
  await page.goto(`${stack.dashboard}/a/payout/`);
  const request = page.getByRole('button').filter({ hasText: PAYEE }).filter({ hasText: 'In review' });
  await expect(request).toBeVisible();
  await expectAttention('a', { step: 'Review the work', count: 1 });
  // A7 shown while the report is in review (then back to A for the review itself).
  if (has('b', 'owner-attention')) {
    release.activate('b');
    await expectReviewAttention(requestId, 'Reviewed onboarding screens');
    release.activate('a');
    await page.goto(`${stack.dashboard}/a/payout/`);
  }

  // 4. Review decides compensation only; nothing is paid.
  await request.click();
  if (!has('a', 'owner-attention')) expect(new URL(page.url()).searchParams.has('request'), 'before A7 selection leaves the address alone').toBe(false);
  await page.getByLabel('Compensation · USDC', { exact: true }).fill('25');
  await page.getByLabel('Review feedback', { exact: true }).fill('Accepted: reviews delivered.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve compensation', exact: true }).click();
  await expect(page.getByText('Compensation approved').first()).toBeVisible();
  expect(stack.simulated.transfers).toHaveLength(0);
  await refusedPreparation('a');

  // 5. Compatible release B: same session and records; an open A page still loads A's hashed assets.
  release.activate('b');
  expect(await served()).toBe(html('b'));
  await skillMatches('b');
  for (const chunk of aChunks) expect(await page.evaluate(async path => (await fetch(path)).status, chunk), chunk).toBe(200);
  await expectDeepLink('b', requestId, 'Reviewed onboarding screens');
  await expectReportLink('b', agreementId);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reports & payment requests' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show all requests' }).click();
  await page.getByRole('button').filter({ hasText: PAYEE }).first().click();
  await expect(page.getByText('Compensation approved').first()).toBeVisible();
  await expectReviewCount('b', 'Awaiting your review: 0');
  expect(stack.protoPids()).toEqual(proto);
  await refusedPreparation('b');

  // 6. Isolated payout preparation records an order; nothing is sent.
  const deadline = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
  await page.getByLabel('Isolated order payment deadline (UTC)', { exact: true }).fill(deadline);
  await prepareIsolated('b').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Prepare payout', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Authorize work order', exact: true })).toBeVisible();
  await expectAttention('b', { step: 'Authorize the order agent', count: 1 });
  if (has('b', 'owner-attention')) {
    await expect(page.getByText('Isolated order: its own agent, grant and funding.').first()).toBeVisible();
    await expect(page.getByText('Paid through')).toHaveCount(0);
  }

  // 7. Owner authorizes the order agent and its grant (wallet signatures), then funds it exactly (simulated deposit).
  const signed = signatures();
  await confirmAction(page, 'Authorize work order');
  await expect.poll(() => stack.simulated.created().length).toBe(1);
  await expect(page.getByRole('button', { name: 'Authorize invoice grant', exact: true })).toBeEnabled({ timeout: 30_000 });
  await confirmAction(page, 'Authorize invoice grant');
  await expect(page.getByText('Fund this work order')).toBeVisible({ timeout: 30_000 });
  expect(signatures()).toBe(signed + 2);
  await page.getByText('Fund this work order').click();
  await page.getByRole('button', { name: 'Get USDC deposit address' }).click();
  await expect(page.getByText(/^Deposit address: /)).toBeVisible();
  const [agent] = stack.simulated.created();
  stack.simulated.fund(agent, '25000000');

  // 8. The payee files the order once; the payout is held for approval, not paid.
  const filed = await payee('POST', `/api/work-orders/${requestId}/file`, {});
  expect(filed.status).toBe(200);
  expect(stack.simulated.transfers).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh work order' }).click();
  await expect(page.getByText('Recorded payment: Held for owner approval; not paid.')).toBeVisible();
  await expectAttention('b', { step: 'Approve the held payout', count: 1, landing: LANDING_HELD });

  // 9. Incompatible release C is refused before any HTML; records are unchanged.
  const before = { records: stack.records(), transfers: JSON.stringify(stack.simulated.transfers) };
  release.activate('c');
  const refused = await page.evaluate(async () => { const r = await fetch('/a/payout/', { cache: 'no-store' }); return { status: r.status, body: await r.json() }; });
  expect(refused.status).toBe(503);
  expect(refused.body.error).toMatch(/records and any submitted actions are unchanged/);
  // The release server is up and serves C's contract: the refusal is the compatibility check, not an outage.
  const cContract = await (await fetch(`${release.origin}/contract.json`)).json();
  expect(cContract.required, "C's incompatible contract is served").toContain(`${cContract.product}-unknown-v9`);
  expect(stack.records()).toEqual(before.records);
  expect(JSON.stringify(stack.simulated.transfers)).toBe(before.transfers);

  // 10. Rollback to A: presentation only, same session.
  release.activate('a');
  expect(await served()).toBe(html('a'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reports & payment requests' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toHaveCount(0);
  await expectReviewCount('a');
  await expectDeepLink('a', requestId, 'Reviewed onboarding screens');
  await expectReportLink('a', agreementId);

  // 11. Owner approves the held payout (one wallet signature); approval is not payment.
  await page.getByRole('button', { name: 'Show all requests' }).click();
  await page.getByRole('button').filter({ hasText: PAYEE }).first().click();
  await confirmAction(page, 'Approve work order payment');
  await expect.poll(() => stack.simulated.transfers[0].status).toBe('PROCESSING');
  expect(signatures()).toBe(signed + 3);
  expect((await payee('GET', `/api/work-orders/${requestId}`)).body.invoice.status).not.toBe('paid');

  // 12. Simulated settlement is observed by both sides; one transfer from the order agent.
  stack.simulated.settle(stack.simulated.transfers[0].correlation);
  await expect.poll(async () => (await payee('GET', `/api/work-orders/${requestId}`)).body.invoice?.status).toBe('paid');
  await page.getByRole('button', { name: 'Refresh work order' }).click();
  await expect(page.getByText('Recorded payment: paid')).toBeVisible();
  expect(stack.simulated.transfers).toHaveLength(1);
  expect(stack.simulated.transfers[0]).toMatchObject({ agent, body: { recipient: PAYEE, amount: '25000000' } });
  await expectAttention('a', { step: 'Paid', count: 0, landing: LANDING_CLEAR });
  if (has('b', 'owner-attention')) {
    release.activate('b');
    await expectAttention('b', { step: 'Paid', count: 0, landing: LANDING_CLEAR });
  }

  // 13. Throughout: Proto never restarted, nothing signed twice, and no Portfolio-only capability was requested.
  expect(stack.protoPids(), 'E2E_NO_PROTO_RESTART').toEqual(proto);
  expect(signatures()).toBe(signed + 3);
  expect(portfolioOnly.filter(c => requestedCapabilities(people.owner.applicationRequests).has(c))).toEqual([]);
  // Every owner answer the real UI received conforms to the published contract, field for field.
  await conformance.settle();
  writeFileSync(info.outputPath('conformance.json'), JSON.stringify(conformance.results, null, 2));
  writeFileSync(info.outputPath('conformance-aborted.json'), JSON.stringify(conformance.aborted, null, 2));
  expect(conformance.results.filter(r => !r.ok)).toEqual([]);
});
