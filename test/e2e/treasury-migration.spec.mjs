import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { PAYEE, USDC } from './provider.mjs';
import { ownerCapabilities } from '../../src/contract/owner-capabilities.ts';
import { recordConformance } from './conformance.mjs';
import { outcomeRegion, previewAndExecute, quoteRegion, seedStrategy, signIn } from './treasury-journey.mjs';

// M4: Treasury's migrated releases (A2/B2, A3/B3, …) released independently behind the gateway on a Treasury-only host.
// The journey is unchanged: quote, explicit confirmation, exact-plan outcome. The app names release B's change
// (`--treasury-change`), and the spec requires it present in B and absent in A; earlier changes are present in both.
const apps = JSON.parse(process.env.PROTO_E2E_OWNER_APPS ?? '{}');
// `account-scoped-reads` (A4) and `session-revalidation` (A5) are asserted by shared-reader.spec.mjs; they have no
// B-only page text here. `guided-run` (A6): /demo#preview opens the guided run at its preview step. `access-wait` (A7):
// only the served bundle is checked here (the guard's message); this journey never creates an agent, so the behaviour is
// evidenced by Treasury's browser-a7 scenarios hostedSetup_{signout,switch,timeout} and its creation run run-v66Btv.
// `send-block` (A8): while the unresolved read reports an operation, Execute and Shield are not offered and say why
// (Preview stays available), Activity says resolution is a separate owner-authorized step, and an execution the server
// refuses before sending (the read not yet refreshed) shows that refusal, never an exact-plan outcome. The refusal is
// asserted by the race test below, on a fresh stack per release.
const CHANGES = ['unresolved-guidance', 'operations-read-time', 'account-scoped-reads', 'session-revalidation', 'guided-run', 'access-wait', 'send-block'];
const SEND_BLOCK = 'New sends are blocked by 1 unresolved operation. Preview is still available.';
const RESOLUTION_STEP = 'Resolving it is a separate step that needs the owner’s authorization. This page cannot clear, retry or replay it.';
const REFUSED_BEFORE_SENDING = 'Unresolved operations block new sends. Nothing was sent.';
const ACCESS_WAIT_GUARD = 'Another account signed in before the new workspace opened.';
const change = JSON.parse(process.env.PROTO_E2E_OWNER_CHANGES ?? '{}').treasury;
/** Whether a release has a change: B has its own, and both have every earlier generation's. */
const has = (release, name) => CHANGES.indexOf(name) < CHANGES.indexOf(change) || (release === 'b' && name === change);
const capabilityOf = procedure => Object.entries(ownerCapabilities).filter(([, c]) => c.procedures.includes(procedure)).map(([name]) => name);
const UNRESOLVED_GUIDANCE = 'Unresolved operations block new sends. Nothing was sent. Follow their outcomes before another action.';

test.skip(!apps.treasury, 'Requires --treasury-dist and --treasury-dist-next');
test.skip(!CHANGES.includes(change), `Requires --treasury-change naming release B's change: ${CHANGES.join(' | ')}`);
test(`Treasury migrated A→B (${change}): journey, B's change in B only, refused C and rollback, without restarting Proto`, async ({ browser }, info) => {
  test.setTimeout(240_000);
  const stack = await environment(info.outputPath('environment'), { workspace: true, ownerApp: { product: 'treasury', ...apps.treasury } });
  const owner = await browserContext(browser, stack, PAYEE);
  owner.context.setDefaultTimeout(15_000);
  try {
    const { release } = stack, page = await owner.context.newPage(), proto = stack.protoPids(), conformance = recordConformance(page);
    await conformance.ready;
    const file = (name, path) => readFileSync(join(release.root, release.ids[name], path), 'utf8');
    expect(file('b', 'index.html'), 'release B must differ from A').not.toBe(file('a', 'index.html'));
    const served = () => page.evaluate(async () => (await fetch('/a/portfolio/', { cache: 'no-store' })).text());
    const skill = () => page.evaluate(async () => { const r = await fetch('/skill.md', { cache: 'no-store' }); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; });
    const outcome = outcomeRegion(page), quote = quoteRegion(page);
    const stop = outcome.getByRole('button', { name: 'Stop following this plan' });
    const chunks = file('a', 'index.html').match(/\/static\/(js|css)\/[a-zA-Z0-9_.-]+\.[a-f0-9]{8,}\.(js|css)/g) ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    const executions = () => owner.applicationRequests.filter(r => r.url.endsWith('/rpc/executePlan')).length;
    /** B3: the exact-plan view says when its operations were last read (a time, once the read completes). */
    /** A6: /demo#preview stays on the guided run with its preview step revealed; earlier releases redirect /demo home. Reads only. */
    const MUTATIONS = /\/rpc\/(rebalance|executePlan|owner\/prepare|owner\/submit|strategy\/save|autopilot\/(set|enable|tick|stop))$/;
    const expectGuidedRun = async release => {
      const before = owner.applicationRequests.filter(r => MUTATIONS.test(new URL(r.url).pathname)).length;
      await page.goto(`${stack.dashboard}/a/portfolio/demo#preview`);
      const guide = page.getByRole('heading', { name: 'Run it with your treasury', exact: true });
      if (has(release, 'guided-run')) {
        await expect(guide).toBeVisible();
        expect(new URL(page.url()).pathname).toBe('/a/portfolio/demo');
        await expect(page.getByRole('heading', { name: 'Preview and execute a rebalance', exact: true })).toBeVisible();
        await expect(page.locator('#preview')).toBeInViewport();
        await expect(page.locator('#preview').getByRole('button', { name: 'Preview', exact: true })).toHaveCount(1);
      } else {
        await expect.poll(() => new URL(page.url()).pathname).toBe('/a/portfolio/');
        await expect(guide).toHaveCount(0);
        await expect(page.locator('#preview')).toHaveCount(0);
      }
      expect(owner.applicationRequests.filter(r => MUTATIONS.test(new URL(r.url).pathname)).length, 'opening the guided run sends nothing').toBe(before);
    };
    /** A7: the access wait's guard message is in the release's served JS, and absent before A7. The code, not its behaviour. */
    const expectAccessWait = async name => {
      const root = join(release.root, release.ids[name]);
      const scripts = readdirSync(join(root, 'static'), { recursive: true }).filter(f => f.endsWith('.js')).map(f => `/static/${f}`);
      expect(scripts.length).toBeGreaterThan(0);
      const bodies = await page.evaluate(async paths => Promise.all(paths.map(async path => { const r = await fetch(path, { cache: 'no-store' }); return { path, status: r.status, body: await r.text() }; })), scripts);
      for (const { path, status } of bodies) expect(status, path).toBe(200);
      expect(bodies.some(({ body }) => body.includes(ACCESS_WAIT_GUARD)), `access-wait guard served by ${name.toUpperCase()}`).toBe(has(name, 'access-wait'));
    };
    /** Sweeps sent with `execute: true` (a preview sends `execute: false`). */
    const shields = [];
    page.on('request', request => { if (request.url().endsWith('/rpc/sweep') && /"execute":true/.test(request.postData() ?? '')) shields.push(request.url()); });
    /**
     * A8: with one unresolved operation, Preview answers, while Execute and Shield are disabled with the reason, and Activity
     * says resolution is the owner's separate step. Before A8, Execute is offered after Preview and neither text appears.
     * Previewing saves a plan and sends nothing.
     */
    const expectSendBlock = async release => {
      const before = executions(), shielded = shields.length;
      await page.goto(`${stack.dashboard}/a/portfolio/`);
      await quote.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(quote.getByText(/Minimum received/).first()).toBeVisible({ timeout: 30_000 });
      const execute = quote.getByRole('button', { name: 'Execute', exact: true }), sweep = page.getByRole('region', { name: 'Confidential sweep', exact: true });
      if (has(release, 'send-block')) {
        await expect(execute).toBeDisabled();
        await expect(quote.getByText(SEND_BLOCK, { exact: true })).toBeVisible();
        await expect(sweep.getByText(SEND_BLOCK, { exact: true })).toBeVisible();
        await expect(sweep.getByRole('button', { name: 'Shield' })).toBeDisabled();
      } else {
        await expect(execute).toBeEnabled();
        await expect(page.getByText(SEND_BLOCK)).toHaveCount(0);
      }
      expect(executions(), 'previewing never executes').toBe(before);
      expect(shields.length, 'no sweep with execute: true').toBe(shielded);
      await page.goto(`${stack.dashboard}/a/portfolio/activity`);
      await expect(page.getByText('Unresolved operations', { exact: true }).first()).toBeVisible();
      if (has(release, 'send-block')) {
        await expect(page.getByText('New sends are blocked by 1 unresolved operation.', { exact: true })).toBeVisible();
        await expect(page.getByText(RESOLUTION_STEP, { exact: true })).toBeVisible();
      } else await expect(page.getByText(RESOLUTION_STEP)).toHaveCount(0);
    };
    const expectReadTime = async release => {
      const read = outcome.getByText(/^Operations last read: /);
      if (!has(release, 'operations-read-time')) { await expect(read).toHaveCount(0); return; }
      await expect(read).toHaveText(/^Operations last read: (?!not yet)\S/);
      await expect(outcome.getByText('A read time shows when records were checked, not that an operation settled.')).toBeVisible();
    };

    // A: sign in once; the page and /skill.md come from A.
    await signIn(page, stack);
    expect(await served()).toBe(file('a', 'index.html'));
    expect(await skill()).toEqual({ status: 200, type: expect.stringMatching(/^text\/markdown/), body: file('a', 'skill.md') });
    const me = await page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(me.capabilities).toEqual(expect.arrayContaining(['treasury-plans-v1', 'agent-schedule-stop-v1']));
    expect(me.capabilities.filter(c => c.startsWith('payables-'))).toEqual([]);

    // A's journey: quote → "Execute swaps" (exactly one executePlan) → ?plan=<id> → exact-plan reload with no replay → Stop following.
    seedStrategy(stack);
    await page.reload();
    await previewAndExecute(page, executions);
    await expect.poll(() => new URL(page.url()).searchParams.get('plan')).toMatch(/^[0-9a-f-]{36}$/);
    const plan = new URL(page.url()).searchParams.get('plan');
    await expect(outcome).toBeVisible({ timeout: 30_000 });
    await expect(outcome.getByRole('heading', { name: 'Follow the outcome' })).toBeVisible();
    await expect.poll(() => stack.portfolio.swaps.length).toBeGreaterThan(0);
    expect(executions(), 'exactly one explicit execution').toBe(1);
    await page.reload();
    await expect(outcome.getByText('Following the exact plan named in this page’s address.')).toBeVisible();
    await expectReadTime('a');
    await expectAccessWait('a');
    expect(executions(), 'reload never replays').toBe(1);
    await stop.click();
    await expect.poll(() => new URL(page.url()).searchParams.has('plan')).toBe(false);
    await expect(outcome).toHaveCount(0);

    // An earlier operation without a proven outcome: a swap whose response is lost (not through the app's UI).
    stack.portfolio.dropSwapResponse(1);
    const lost = await page.evaluate(async usdc => {
      const rpc = (procedure, input) => fetch(`/a/portfolio/rpc/${procedure}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
      const { json: saved } = await (await rpc('externalPlan', { swaps: [{ from: usdc, to: 'nep141:wrap.near', amount: '1000000' }] })).json();
      return (await rpc('executePlan', { planId: saved.id })).text();
    }, USDC);
    expect(lost).toMatch(/event: error/);
    const unresolved = await page.evaluate(async () => (await (await fetch('/a/portfolio/rpc/unresolved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).json);
    expect(unresolved.length).toBeGreaterThan(0);

    // The journey reached its targets: a new target needs another rebalance.
    seedStrategy(stack, 5000);

    /** Execute once more through the app: exactly one executePlan, refused as unresolved, nothing sent. */
    const refusedExecution = async () => {
      const swaps = stack.portfolio.swaps.length, before = executions();
      await page.goto(`${stack.dashboard}/a/portfolio/`);
      await previewAndExecute(page, executions);
      await expect.poll(executions).toBe(before + 1);
      await expect(quote.getByText(/nothing new was sent|Nothing was sent/).first()).toBeVisible();
      expect(executions(), 'exactly one executePlan').toBe(before + 1);
      expect(stack.portfolio.swaps.length, 'nothing sent').toBe(swaps);
      // The browser drops a response body on navigation: the recorder reads this answer before the page moves on.
      await conformance.settle();
    };
    /** B2's kind-based guidance for an unresolved refusal; without it, only the server's refusal is shown. */
    const expectUnresolvedGuidance = async release => {
      if (!has(release, 'unresolved-guidance')) {
        await expect(quote.getByText(/Earlier money actions have no proven outcome, so nothing new was sent/).first()).toBeVisible();
        await expect(page.getByText(UNRESOLVED_GUIDANCE)).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Review unresolved operations' })).toHaveCount(0);
        return;
      }
      await expect(quote.getByRole('status').filter({ hasText: UNRESOLVED_GUIDANCE })).toBeVisible();
      await expect(quote.getByRole('link', { name: 'Review unresolved operations' })).toHaveAttribute('href', /\/a\/portfolio\/activity$/);
      await expect(page.getByText(/outcome is unknown/i)).toHaveCount(0);
      await expect(page.getByText(/pnpm reconcile|reconcile cannot resolve/)).toHaveCount(0);
    };
    await refusedExecution();
    await expectUnresolvedGuidance('a');
    await expectSendBlock('a');

    // Compatible release B: same session; an open A page still loads A's hashed assets; B's change works.
    release.activate('b');
    expect(await served()).toBe(file('b', 'index.html'));
    // An open A page still gets A's own bytes, not a fallback page or B's bundle.
    for (const chunk of chunks) expect(await page.evaluate(async path => { const r = await fetch(path); return { status: r.status, body: await r.text() }; }, chunk), chunk)
      .toEqual({ status: 200, body: file('a', chunk.slice(1)) });
    expect((await skill()).body).toBe(file('b', 'skill.md'));
    // From A8 Execute is not offered while the read reports the operation, so B's refusal is asserted by the race test.
    if (has('b', 'send-block')) await expectSendBlock('b');
    else {
      await refusedExecution();
      await expectUnresolvedGuidance('b');
    }
    await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toHaveCount(0);
    const executed = executions();
    await page.goto(`${stack.dashboard}/a/portfolio/?plan=${plan}`);
    await expect(outcome).toBeVisible();
    await expectReadTime('b');
    expect(executions(), 'reopening the plan never replays').toBe(executed);
    await expectGuidedRun('b');
    await expectAccessWait('b');

    // Incompatible release C is refused; records are unchanged: provider swaps, and the agent's saved plans, operation
    // journal and owner records (every file under them, byte for byte).
    const swaps = JSON.stringify(stack.portfolio.swaps);
    const portfolioRecords = () => Object.fromEntries(['.plans', '.ops', '.owner-intents'].flatMap(dir => {
      const root = join(stack.directory, 'portfolio', dir);
      return existsSync(root) ? readdirSync(root, { recursive: true }).filter(f => !f.endsWith('.lock') && statSync(join(root, f)).isFile()).map(f => [`${dir}/${f}`, readFileSync(join(root, f), 'utf8')]) : [];
    }));
    const recordsBefore = portfolioRecords();
    expect(Object.keys(recordsBefore).some(f => f.startsWith('.plans/')), 'the executed plan is on disk').toBe(true);
    release.activate('c');
    const refused = await page.evaluate(async () => { const r = await fetch('/a/portfolio/', { cache: 'no-store' }); return { status: r.status, body: await r.json() }; });
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatch(/records and any submitted actions are unchanged/);

    // Rollback to A: the same exact plan reopens, with no replay; A's views return.
    release.activate('a');
    expect(await served()).toBe(file('a', 'index.html'));
    expect((await skill()).body).toBe(file('a', 'skill.md'));
    await page.goto(`${stack.dashboard}/a/portfolio/?plan=${plan}`);
    await expect(outcome).toBeVisible();
    await expectReadTime('a');
    await expectGuidedRun('a');
    await expectAccessWait('a');
    expect(JSON.stringify(stack.portfolio.swaps)).toBe(swaps);
    expect(portfolioRecords(), 'plans, journal and owner records unchanged across refusal and rollback').toEqual(recordsBefore);
    expect(executions()).toBe(executed);
    // A's controls return (after the records comparison: a preview saves a plan).
    await expectSendBlock('a');
    expect(stack.protoPids(), 'E2E_NO_PROTO_RESTART').toEqual(proto);
    const requested = new Set(owner.applicationRequests.map(r => new URL(r.url).pathname.match(/^\/a\/[a-z0-9-]+\/rpc\/(.+)$/)?.[1]).filter(Boolean).flatMap(capabilityOf));
    expect([...requested].filter(c => c.startsWith('payables-'))).toEqual([]);
    await conformance.settle();
    writeFileSync(info.outputPath('conformance.json'), JSON.stringify(conformance.results, null, 2));
    writeFileSync(info.outputPath('conformance-aborted.json'), JSON.stringify(conformance.aborted, null, 2));
    expect(conformance.results.filter(r => !r.ok)).toEqual([]);
  } finally {
    await owner.context.close(); await stack.close();
    expect(stack.simulated.errors).toEqual([]); expect(stack.portfolio.errors).toEqual([]);
    expect(owner.unexpected).toEqual([]);
  }
});

/**
 * A8 `send-block`: the server refuses an execution before sending while the page's unresolved read is not yet refreshed
 * (it refreshes every 30 s). From A8 the page shows that refusal and no exact-plan outcome; earlier releases open the
 * confirmed-plan outcome. One fresh stack per release, since the unresolved operation cannot be cleared.
 */
for (const name of ['a', 'b']) {
  test(`Treasury ${name.toUpperCase()} (${change}): an execution refused before sending shows the refusal`, async ({ browser }, info) => {
    test.skip(!has('b', 'send-block'), 'Asserted from A8 (send-block) onward');
    test.setTimeout(180_000);
    const stack = await environment(info.outputPath('environment'), { workspace: true, ownerApp: { product: 'treasury', ...apps.treasury } });
    const owner = await browserContext(browser, stack, PAYEE);
    owner.context.setDefaultTimeout(15_000);
    try {
      const { release } = stack, page = await owner.context.newPage(), quote = quoteRegion(page), outcome = outcomeRegion(page);
      if (name === 'b') release.activate('b');
      const executions = () => owner.applicationRequests.filter(r => r.url.endsWith('/rpc/executePlan')).length;
      await signIn(page, stack);
      expect(await page.evaluate(async () => (await fetch('/a/portfolio/', { cache: 'no-store' })).text()))
        .toBe(readFileSync(join(release.root, release.ids[name], 'index.html'), 'utf8'));
      seedStrategy(stack);
      await page.reload();
      // Nothing is unresolved yet: Preview, so Execute is offered.
      await quote.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(quote.getByText(/Minimum received/).first()).toBeVisible({ timeout: 30_000 });
      await expect(quote.getByRole('button', { name: 'Execute', exact: true })).toBeEnabled();
      // Then an operation without a proven outcome appears outside the page (a lost swap response).
      stack.portfolio.dropSwapResponse(1);
      const lost = await page.evaluate(async usdc => {
        const rpc = (procedure, input) => fetch(`/a/portfolio/rpc/${procedure}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
        const { json: saved } = await (await rpc('externalPlan', { swaps: [{ from: usdc, to: 'nep141:wrap.near', amount: '1000000' }] })).json();
        return (await rpc('executePlan', { planId: saved.id })).text();
      }, USDC);
      expect(lost).toMatch(/event: error/);
      const swaps = stack.portfolio.swaps.length, before = executions();
      // The page hasn't re-read yet: Execute is still offered, and the server refuses before sending.
      await quote.getByRole('button', { name: 'Execute', exact: true }).click();
      await page.getByRole('dialog', { name: 'Execute the previewed rebalance on mainnet?' }).getByRole('button', { name: 'Execute swaps', exact: true }).click();
      await expect.poll(executions).toBe(before + 1);
      // Both releases show the server's refusal; only the outcome view after it differs.
      await expect(quote.getByText(/nothing new was sent|Nothing was sent/).first()).toBeVisible({ timeout: 30_000 });
      if (has(name, 'send-block')) {
        await expect(quote.getByText(REFUSED_BEFORE_SENDING).first()).toBeVisible();
        await expect(outcome).toHaveCount(0);
        await expect.poll(() => new URL(page.url()).searchParams.has('plan')).toBe(false);
        await expect(page.getByText(/does not establish that nothing was sent/)).toHaveCount(0);
        // Once the read refreshes, Execute is not offered, with the reason.
        await expect(quote.getByText(SEND_BLOCK, { exact: true })).toBeVisible({ timeout: 45_000 });
        await expect(quote.getByRole('button', { name: 'Execute', exact: true })).toBeDisabled();
      } else {
        // Settled after the refusal (A8 opens the outcome on Execute too, then closes it when refused): it stays open.
        await page.waitForTimeout(2_000);
        await expect(outcome).toBeVisible();
        expect(new URL(page.url()).searchParams.get('plan')).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(executions(), 'exactly one executePlan from the page').toBe(before + 1);
      expect(stack.portfolio.swaps.length, 'nothing sent').toBe(swaps);
    } finally {
      await owner.context.close(); await stack.close();
      expect(stack.simulated.errors).toEqual([]); expect(stack.portfolio.errors).toEqual([]);
      expect(owner.unexpected).toEqual([]);
    }
  });
}
