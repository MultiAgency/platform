import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';
import { writeFileSync } from 'node:fs';
import { recordConformance } from './conformance.mjs';

// The example prototype, built with rsbuild against @multiagency/sdk, is served as the showcase host's own build; every
// call goes through the real gateway and agent server. Wallet signatures are real NEP-413 from the unfunded fixture key;
// the provider is simulated.
const example = join(import.meta.dirname, '../../examples/minimal-prototype');
function build(dist) {
  const built = spawnSync(join(import.meta.dirname, '../../node_modules/.bin/rsbuild'), ['build', '--root', example], { env: { ...process.env, EXAMPLE_DIST: dist }, encoding: 'utf8' });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  return dist;
}
const KEY = 'minimal-prototype:payout:owner-action';

test('a new prototype signs in through the gateway, reads its scoped agent and takes one owner-signed action', async ({ browser }, info) => {
  const stack = await environment(info.outputPath('environment'), { frontendDist: build(info.outputPath('dist')) });
  const owner = await browserContext(browser, stack, OWNER), payee = await browserContext(browser, stack, PAYEE);
  try {
    const page = await owner.context.newPage(), conformance = recordConformance(page);
    await conformance.ready;
    await page.goto(`${stack.dashboard}/a/payout/`);
    await expect(page).toHaveTitle('Minimal prototype');
    await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
    const chooser = page.getByText('Local test wallet', { exact: true });
    await Promise.race([chooser.waitFor().then(() => chooser.click()).catch(() => {}), page.getByText(`Signed in as ${OWNER}.`).waitFor()]);
    await expect(page.getByText(`Signed in as ${OWNER}.`)).toBeVisible();
    await expect(page.locator('#agent')).toHaveText('Active.');

    const signedBefore = owner.signatures.length;
    // A read while the preparation is still in flight leaves the action disabled: one click, one preparation.
    let answerPrepare; const held = new Promise(resolve => { answerPrepare = resolve; });
    let prepares = 0;
    page.on('request', request => { if (request.url().endsWith('/a/payout/rpc/owner/prepare')) prepares++; });
    await page.route('**/a/payout/rpc/owner/prepare', async route => { await held; await route.continue(); }, { times: 1 });
    await page.getByRole('button', { name: 'Pause agent' }).click();
    await expect.poll(() => prepares).toBe(1);
    const reread = page.waitForResponse(response => response.url().endsWith('/a/payout/rpc/overview'));
    await page.getByRole('button', { name: 'Read again' }).click();
    await reread;
    await expect(page.getByRole('button', { name: 'Pause agent' })).toBeDisabled();
    answerPrepare();
    await expect(page.getByRole('status')).toHaveText('Signed and recorded.');
    expect(prepares).toBe(1);
    await expect(page.locator('#agent')).toHaveText('Paused by its owner.');
    expect(owner.signatures.length).toBe(signedBefore + 1);
    await page.getByRole('button', { name: 'Resume agent' }).click();
    await expect(page.getByRole('status')).toHaveText('Signed and recorded.');
    await expect(page.locator('#agent')).toHaveText('Active.');
    expect(owner.signatures.length).toBe(signedBefore + 2);
    const controls = stack.simulated.intents.filter(i => i.control);
    expect(controls.map(i => [i.control, i.submitted])).toEqual([['agent_freeze', true], ['agent_unfreeze', true]]);
    expect(stack.simulated.requests.filter(r => r.path === '/v1/submit-intent')).toHaveLength(2);
    expect(await page.evaluate(key => localStorage.getItem(key), KEY), 'a settled action is no longer kept').toBeNull();

    // The same host refuses scoped reads and actions without this owner's session.
    const other = await payee.context.newPage();
    await other.goto(`${stack.dashboard}/a/payout/`);
    const refused = await other.evaluate(async () => Promise.all(['overview', 'owner/prepare'].map(async procedure =>
      (await fetch(`/a/payout/rpc/${procedure}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: { action: { type: 'agent_freeze' }, signer: 'wallet' } }) })).status)));
    expect(refused).toEqual([401, 401]);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(owner.unexpected).toEqual([]); expect(payee.unexpected).toEqual([]);
    await conformance.settle();
    writeFileSync(info.outputPath('conformance.json'), JSON.stringify(conformance.results, null, 2));
    writeFileSync(info.outputPath('conformance-aborted.json'), JSON.stringify(conformance.aborted, null, 2));
    expect(conformance.results.filter(r => !r.ok)).toEqual([]);
  } finally {
    await owner.context.close(); await payee.context.close();
    await stack.close();
    expect(stack.simulated.errors).toEqual([]);
  }
});

test('an uncertain submission is followed by its prepared correlationId across a reload, never signed or submitted again', async ({ browser }, info) => {
  const stack = await environment(info.outputPath('environment'), { frontendDist: build(info.outputPath('dist')) });
  const owner = await browserContext(browser, stack, OWNER);
  try {
    const page = await owner.context.newPage();
    await page.goto(`${stack.dashboard}/a/payout/`);
    await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
    const chooser = page.getByText('Local test wallet', { exact: true });
    await Promise.race([chooser.waitFor().then(() => chooser.click()).catch(() => {}), page.getByText(`Signed in as ${OWNER}.`).waitFor()]);
    await expect(page.locator('#agent')).toHaveText('Active.');
    const submits = () => stack.simulated.requests.filter(r => r.path === '/v1/submit-intent').length;
    const signedIn = owner.signatures.length, signatures = () => owner.signatures.length - signedIn;
    const kept = async () => JSON.parse(await page.evaluate(key => localStorage.getItem(key), KEY));

    // 1. The preparation's request fails in transport, so no correlationId reaches the page: it asks for no signature.
    //    (Aborted before the agent read it; the page sees the same lost answer as a reply lost after preparing.)
    await page.route('**/a/payout/rpc/owner/prepare', route => route.abort('connectionreset'), { times: 1 });
    await page.getByRole('button', { name: 'Pause agent' }).click();
    await expect(page.getByRole('status')).toContainText('no id to follow it by');
    expect(signatures()).toBe(0);
    expect(submits()).toBe(0);
    expect(await kept()).toBeNull();

    // 2. The provider accepts the signed submission but its reply is lost, and the outcome stays withheld.
    stack.simulated.dropSignatureResponse();
    await page.getByRole('button', { name: 'Pause agent' }).click();
    await expect.poll(submits).toBe(1);
    await expect(page.getByRole('status')).toContainText(/do not sign again/i);
    expect(signatures()).toBe(1);
    const action = await kept();
    expect(action).toEqual({ correlationId: expect.any(String), type: 'agent_freeze', phase: 'submitting' });
    await expect.poll(() => stack.ownerRecords()[action.correlationId]?.stage).toBe('submitted');

    // 3. Reload while the outcome is unknown: the page resumes the same action, still without signing or submitting.
    await page.reload();
    await expect(page.getByRole('status')).toContainText(/do not sign again/i);
    expect(await kept()).toEqual(action);
    await expect(page.getByRole('button', { name: 'Pause agent' })).toBeDisabled();

    // 4. The outcome becomes readable: after a reload the page reads it for the same correlationId and keeps nothing.
    //    The page is away meanwhile, so its still-running follow can't read the outcome before the reload does.
    await page.goto('about:blank');
    stack.simulated.revealOwnerOutcome();
    await expect.poll(() => stack.ownerRecords()[action.correlationId]?.stage, { timeout: 30_000 }).toBe('settled');
    await page.goto(`${stack.dashboard}/a/payout/`);
    await expect(page.getByRole('status')).toHaveText('Signed and recorded.');
    await expect(page.locator('#agent')).toHaveText('Paused by its owner.');
    expect(signatures(), 'never signed again').toBe(1);
    expect(submits(), 'never submitted again').toBe(1);
    expect(stack.simulated.intents.filter(i => i.control && i.submitted).map(i => i.control), 'one submitted freeze').toEqual(['agent_freeze']);
    expect(await kept()).toBeNull();
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(owner.unexpected).toEqual([]);
  } finally {
    await owner.context.close();
    await stack.close();
    expect(stack.simulated.errors).toEqual([]);
  }
});
