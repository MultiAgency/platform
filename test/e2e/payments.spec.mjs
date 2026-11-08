import { test as base, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext, connectWallet } from './wallet.mjs';
import { OWNER, PAYEE, sign } from './provider.mjs';
import { ownerRpc } from './payables-steps.mjs';


const test = base.extend({
  stack: async ({}, use, info) => {
    const stack = await environment(info.outputPath('environment'));
    try { await use(stack); }
    finally { await stack.close(); expect(stack.simulated.errors).toEqual([]); }
  },
  people: async ({ browser, stack }, use, info) => {
    stack.browserVersion = browser.version();
    const owner = await browserContext(browser, stack, OWNER);
    const payee = await browserContext(browser, stack, PAYEE, { viewport: { width: 390, height: 844 } });
    const contexts = [owner, payee], errors = [];
    for (const { context } of contexts) context.setDefaultTimeout(15_000);
    for (const { context } of contexts) {
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    }
    try { await use({ owner: await owner.context.newPage(), payee: await payee.context.newPage() }); }
    finally {
      for (const [i, { context, unexpected }] of contexts.entries()) {
        for (const [n, page] of context.pages().entries()) {
          await page.screenshot({ path: info.outputPath(`${i}-${n}.png`) }).catch(() => {});
          writeFileSync(info.outputPath(`${i}-${n}.txt`), await page.locator('body').innerText().catch(() => 'Page unavailable'));
        }
        await context.tracing.stop({ path: info.outputPath(`trace-${i}.zip`) });
        await context.close(); expect(unexpected).toEqual([]);
      }
      expect(errors).toEqual([]);
    }
  },
});

async function signInPayee(page, stack) {
  await page.goto(stack.invoices);
  await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
  // Invoice connector opens its wallet selector even with a prior preference.
  const chooser = page.getByText('Local test wallet', { exact: true });
  await chooser.waitFor(); await chooser.click();
  await expect(page.getByRole('button', { name: 'Submit invoice', exact: true })).toBeVisible();
}
async function fileInvoice(page, note = 'Local E2E work') {
  await page.getByLabel('Amount (USDC)').fill('1.25');
  await page.getByLabel("What's it for? (optional)").fill(note);
  const response = page.waitForResponse(r => r.url().endsWith('/api/invoices') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Submit invoice', exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  return { request: result.request().postDataJSON(), response: await result.json() };
}
async function signInOwner(page, stack) {
  await page.goto(`${stack.dashboard}/a/payout/`);
  await connectWallet(page, OWNER);
}

test('invoice, owner approval, and settlement stay distinct across the real stack', async ({ stack, people }) => {
  const { owner, payee } = people;
  await signInPayee(payee, stack);
  const filed = await fileInvoice(payee);
  expect(filed.response.status).toBe('waiting');
  await expect(payee.getByText(/Waiting for approval/)).toBeVisible();
  expect(stack.simulated.transfers, 'E2E_SINGLE_TRANSFER').toHaveLength(1);
  const first = stack.records();
  expect(first.invoices).toHaveLength(1);
  expect(first.payments[0].status).toBe('PENDING_APPROVAL');
  expect(first.reservations[0].released).toBe(0);
  expect(first.payments[0].key).toBe(stack.simulated.transfers[0].key);
  expect(JSON.parse(first.payments[0].request)).toEqual(stack.simulated.transfers[0].body);

  // The owner approves through the platform's owner procedures, as any app does: prepare the vote on the held payout,
  // sign the exact prepared intent, submit it once.
  const rpc = await ownerRpc(owner, stack);
  expect(stack.simulated.intents).toHaveLength(0);
  expect(stack.simulated.transfers).toHaveLength(1);
  const correlationId = stack.simulated.transfers[0].correlation, terms = JSON.parse(first.payments[0].request);
  const { approvalId } = (await rpc('held')).find(h => h.correlationId === correlationId);
  const vote = await rpc('owner/prepare', { action: { type: 'approval_vote', approvalId, verdict: 'approve', correlationId }, signer: 'wallet' });
  expect(vote.payment.terms).toEqual({ recipient: PAYEE, asset: terms.asset, amount: terms.amount });
  const approval = await sign(OWNER, vote.intent.payload);
  await rpc('owner/submit', { correlationId: vote.correlationId, signedData: { ...vote.intent, public_key: approval.publicKey, signature: approval.signature } });
  await expect.poll(() => stack.simulated.intents.filter(i => i.submitted).length).toBe(1);
  await expect.poll(() => Object.values(stack.ownerRecords()).some(r => r.ownerSucceeded === true)).toBe(true);
  await payee.getByRole('button', { name: 'Check invoice status again' }).click();
  await expect(payee.getByText(/Settlement is not yet confirmed/), 'E2E_SETTLEMENT_NOT_APPROVAL').toBeVisible();
  expect(stack.records().reservations[0].released).toBe(0);

  stack.simulated.settle();
  await payee.getByRole('button', { name: 'Check invoice status again' }).click();
  await expect(payee.getByText(/^Paid\.$/)).toBeVisible();
  await expect.poll(() => stack.records().payments[0].status).toBe('SUCCESS');
  expect(stack.records().reservations[0].released).toBe(1);
  await stack.restartExecutor();
  await payee.reload();
  await expect(payee.getByText(/^Paid\.$/)).toBeVisible();
  expect(stack.records().invoices[0].id).toBe(first.invoices[0].id);
  expect(stack.simulated.transfers).toHaveLength(1);
  expect(stack.simulated.requests.filter(r => r.path === '/v1/submit-intent')).toHaveLength(1);
  await expect(payee.locator('#retained-draft')).toBeHidden();
});

test('accepted transfer with lost response stays unresolved after restart and blocks another send', async ({ stack, people }) => {
  const { payee, owner } = people;
  await signInPayee(payee, stack);
  stack.simulated.dropTransferResponse();
  const filed = await fileInvoice(payee, 'Lost response');
  expect(filed.response.status).toBe('unknown');
  await expect(payee.getByText(/do not create a replacement invoice/)).toBeVisible();
  const saved = stack.records();
  expect(saved.payments[0].state).toBe('UNKNOWN');
  expect(saved.payments[0].correlation_id).toBeNull();
  expect(saved.reservations[0].released).toBe(0);
  expect(stack.simulated.transfers).toHaveLength(1);
  await stack.restartExecutor();
  await payee.reload();
  await expect(payee.getByText(/do not create a replacement invoice/)).toBeVisible();
  await expect(payee.locator('#retained-draft')).toContainText('Do not create a replacement while its outcome is unknown.');
  await expect(payee.locator('#retained-draft')).toBeVisible();
  expect(await payee.locator('#retained-draft').evaluate(node => Boolean(node.compareDocumentPosition(document.getElementById('submit')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  // Repeat the original HTTP request to model a browser retry; do not invent another identity.
  const repeat = await payee.evaluate(async data => (await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })).json(), filed.request);
  expect(repeat).toMatchObject({ id: filed.response.id, status: 'unknown' });
  const another = await fileInvoice(payee, 'Blocked next invoice');
  expect(another.response.status).toBe('needs_review');
  expect(another.request.submission).toBe(filed.request.submission);
  const fresh = await payee.evaluate(async data => (await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, submission: crypto.randomUUID() }) })).json(), filed.request);
  expect(fresh.status).toBe('busy');
  expect(stack.records().invoices).toHaveLength(1);
  expect(stack.records().payments[0].key).toBe(saved.payments[0].key);
  expect(stack.records().reservations[0].released).toBe(0);
  expect(stack.simulated.transfers).toHaveLength(1);
  await signInOwner(owner, stack);
  // Approve-only copy must refuse an attempted money action, even for its authenticated operator.
  const result = await owner.evaluate(async ({ payee, asset }) => {
    const rpc = (method, input) => fetch(`/a/payout/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
    const { json: view } = await (await rpc('overview')).json();
    const response = await rpc('pay', { recipient: payee, asset, amount: '1000000', confidential: true,
      expectedPolicy: { revision: 1, digest: view.digest } });
    return { ok: response.ok, text: await response.text() };
  }, { payee: PAYEE, asset: stack.simulated.transfers[0].body.asset });
  expect(stack.simulated.transfers, 'E2E_APPROVE_ONLY_NO_SEND').toHaveLength(1);
  expect(result.ok).toBe(false);
  expect(result.text).toContain('This copy only approves: payouts are sent by the agent');
  expect(result.text).toContain('Nothing was sent.');
  expect(stack.simulated.transfers).toHaveLength(1);
});
