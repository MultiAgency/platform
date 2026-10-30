import { test as base, expect } from '@playwright/test';
import { writeFileSync, cpSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { environment } from './environment.mjs';
import { browserContext, connectWallet } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';

// The owner's approval screens are Payables'; those steps run against its release A (`--payables-dist`).
const apps = JSON.parse(process.env.PROTO_E2E_OWNER_APPS ?? '{}');
const payablesApp = apps.payables ? { ownerApp: { product: 'payables', ...apps.payables } } : {};

const test = base.extend({
  stack: async ({}, use, info) => {
    const stack = await environment(info.outputPath('environment'), payablesApp);
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
    try { await use({ owner: await owner.context.newPage(), payee: await payee.context.newPage(), ownerRequests: owner.applicationRequests, ownerSignatures: owner.signatures }); }
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
const ownerScreens = () => test.skip(!apps.payables, 'The owner approval screens require --payables-dist and --payables-dist-next');

test('invoice, owner approval, and settlement stay distinct across the real stack', async ({ stack, people }) => {
  ownerScreens();
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

  await signInOwner(owner, stack);
  expect(people.ownerRequests.filter(r => new URL(r.url).pathname.endsWith('/paymentStatus'))).toEqual([]);
  expect(stack.simulated.intents).toHaveLength(0);
  expect(stack.simulated.transfers).toHaveLength(1);
  await owner.getByRole('link').filter({ hasText: 'Review payment' }).first().click();
  await expect(owner.getByText('Owner decision', { exact: true })).toBeVisible();
  await owner.getByRole('button', { name: 'Sign approval', exact: true }).click();
  await owner.getByRole('button', { name: 'Continue to wallet', exact: true }).click();
  await expect.poll(() => stack.simulated.intents.filter(i => i.submitted).length).toBe(1);
  await expect.poll(() => Object.values(stack.ownerRecords()).some(r => r.ownerSucceeded === true)).toBe(true);
  await owner.reload();
  await expect(owner.getByRole('term').filter({ hasText: /^Payment outcome$/ })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Sign approval', exact: true })).toHaveCount(0);
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


test('lost owner signature response survives reviewer restart without signing or submitting again', async ({ stack, people }) => {
  ownerScreens();
  const { owner, payee, ownerSignatures } = people;
  await signInPayee(payee, stack);
  await fileInvoice(payee, 'Owner response lost');
  await signInOwner(owner, stack);
  await owner.getByRole('link').filter({ hasText: 'Review payment' }).first().click();
  stack.simulated.dropSignatureResponse();
  await owner.getByRole('button', { name: 'Sign approval', exact: true }).click();
  await owner.getByRole('button', { name: 'Continue to wallet', exact: true }).click();
  await expect.poll(() => stack.simulated.intents.filter(i => i.submitted).length).toBe(1);
  const correlation = stack.simulated.intents[0].correlation_id;
  await expect.poll(() => stack.ownerRecords()[correlation]?.stage).toBe('submitted');
  expect(stack.ownerRecords()[correlation].ownerSucceeded).not.toBe(true);
  const persistedSignature = stack.ownerRecords()[correlation].signedData;
  expect(persistedSignature.signature).toBeTruthy();
  await stack.restartReviewer();
  await owner.reload();
  await expect(owner.getByText(/Submission attempted.*Do not sign again/)).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Sign approval', exact: true })).toHaveCount(0);
  expect(stack.ownerRecords()[correlation]).toMatchObject({ stage: 'submitted', signedData: persistedSignature });
  expect(stack.ownerRecords()[correlation].ownerSucceeded).not.toBe(true);
  expect(ownerSignatures.filter(s => s.recipient === 'local-provider')).toHaveLength(1);
  expect(stack.simulated.requests.filter(r => r.path === '/v1/submit-intent')).toHaveLength(1);
  expect(stack.simulated.intents).toHaveLength(1);
  await payee.getByRole('button', { name: 'Check invoice status again' }).click();
  await expect(payee.getByText(/Settlement is not yet confirmed/)).toBeVisible();
  expect(stack.records().reservations[0].released).toBe(0);

  stack.simulated.revealOwnerOutcome();
  await expect.poll(() => stack.ownerRecords()[correlation]?.ownerSucceeded).toBe(true);
  expect(stack.ownerRecords()[correlation].stage).toBe('submitted');
  stack.simulated.settle();
  await expect.poll(() => stack.ownerRecords()[correlation]?.stage).toBe('settled');
  await owner.reload();
  await expect(owner.getByRole('button', { name: 'Sign approval', exact: true })).toHaveCount(0);
  await payee.getByRole('button', { name: 'Check invoice status again' }).click();
  await expect(payee.getByText(/^Paid\.$/)).toBeVisible();
  expect(stack.records().reservations[0].released).toBe(1);
  expect(Object.keys(stack.ownerRecords())).toEqual([correlation]);
  expect(ownerSignatures.filter(s => s.recipient === 'local-provider')).toHaveLength(1);
  expect(stack.simulated.requests.filter(r => r.path === '/v1/submit-intent')).toHaveLength(1);
  expect(stack.simulated.transfers).toHaveLength(1);
});

test('standalone contributor report and work-order requests retain identities across owner review', async ({ stack, people }) => {
  test.skip(!process.env.PROTO_E2E_INVOICES_DIST, 'Requires --invoices-dist-release');
  const { owner, payee } = people;
  await signInOwner(owner, stack);
  const rpc = async (method, input) => owner.evaluate(async ({method,input}) => {
    const response = await fetch(`/a/payout/rpc/${method}`, {method:'POST',headers:{'content-type':'application/json','x-gateway-actor':'forged.near'},body:JSON.stringify({json:input})});
    const value = await response.json(); if(!response.ok) throw new Error(JSON.stringify(value)); return value.json;
  }, {method,input});
  const uuid = () => globalThis.crypto.randomUUID();
  const agreementId = uuid();
  await rpc('compensation/agreement', {commandId:uuid(),id:agreementId,expectedVersion:0,terms:{payee:PAYEE,title:'Standalone report',document:'https://example.test/agreement',signedOn:'2026-10-01',start:'2026-10-01',end:'2026-10-31',ceiling:'10000000',openingApproved:'0',scope:'Offline integration'}});
  const view = await rpc('compensation/list');
  expect(view.agreements[0].recordedBy).toBe(OWNER);
  await signInPayee(payee, stack);
  await payee.getByLabel('Describe the work').fill('Requested work');
  await payee.getByLabel('Work order total (USDC)').fill('2');
  await payee.getByLabel('Deadline (UTC)').fill(new Date(Date.now()+86400000*2).toISOString().slice(0,10));
  await payee.getByRole('button',{name:'Send work order request',exact:true}).click();
  await expect.poll(async()=>(await rpc('workOrders/list')).length).toBe(1);
  expect(stack.simulated.transfers).toHaveLength(0);
  await payee.goto(stack.invoices+'/report');
  // From Invoices J the form opens directly when the payee has no requests yet; I asked for "New report" first.
  const newReport = payee.getByRole('button',{name:'New report',exact:true}), contributions = payee.getByLabel('Contributions',{exact:true});
  await expect(newReport.or(contributions).first()).toBeVisible();
  if (await newReport.isVisible()) await newReport.click();
  await contributions.fill('Extracted contributor frontend');
  await payee.getByLabel('Assessment',{exact:true}).fill('Validated locally');
  await payee.getByRole('button',{name:'Submit',exact:true}).click();
  await expect(payee.getByText('Compensation in review',{exact:true})).toBeVisible();
  const submitted=(await rpc('compensation/list')).requests[0];
  expect(submitted.payee).toBe(PAYEE);
  await rpc('compensation/review',{commandId:uuid(),id:submitted.id,expectedVersion:submitted.version,decision:'approved',approvedAmount:'2000000',feedback:'Reviewed the extracted app'});
  await payee.reload();
  // From J a submitted request stays selected in the address (?request=) across a reload; I listed it to be opened.
  const row = payee.getByRole('button',{name:/Standalone report/}), approved = payee.getByText('2 USDC',{exact:true});
  await expect(row.or(approved).first()).toBeVisible();
  if (await row.isVisible()) await row.click();
  await expect(approved).toBeVisible();
  expect(stack.simulated.transfers).toHaveLength(0);
  expect((await rpc('compensation/list')).requests[0].id).toBe(submitted.id);
});

test('contributor journey survives independent Invoices outage, release, refusal and rollback without restarting Proto', async ({ stack, people }, info) => {
  test.skip(!process.env.PROTO_E2E_INVOICES_DIST, 'Requires --invoices-dist-release');
  const { owner, payee } = people, original = process.env.PROTO_E2E_INVOICES_DIST;
  // Frozen consumer releases are read-only; copies keep that mode, so only the edited file is made writable.
  const release = (name, file, edit) => { const dir = info.outputPath(`release-${name}`); cpSync(original, dir, { recursive: true });
    chmodSync(join(dir, file), 0o644); writeFileSync(join(dir, file), edit(readFileSync(join(dir, file), 'utf8'))); return dir; };
  const titleOf = dir => readFileSync(join(dir, 'index.html'), 'utf8').match(/<title>([^<]*)<\/title>/)[1];
  // Invoices' own release B when supplied; otherwise B is derived from A with a new title.
  const compatible = process.env.PROTO_E2E_INVOICES_NEXT ?? release('b', 'index.html', html => html.replace(/<title>([^<]*)<\/title>/, '<title>$1 release B</title>'));
  // The release's own pages, as its contract declares them (one app may serve every entry from one index.html).
  const pages = dir => [...new Set(Object.values(JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8')).entries).filter(file => file.endsWith('.html')))]
    .sort().map(file => readFileSync(join(dir, file), 'utf8'));
  const presented = dir => pages(dir).join('\0');
  expect(presented(compatible), 'release B must present differently (pages or their hashed bundles)').not.toBe(presented(original));
  const aAssets = [...new Set(pages(original).flatMap(html => html.match(/\/invoice-ui\/static\/[a-zA-Z0-9_./-]+\.[a-f0-9]{8,}\.(js|css)/g) ?? []))];
  expect(aAssets.length, 'release A references hashed assets (otherwise the retained-asset check below is vacuous)').toBeGreaterThan(0);
  const incompatible = release('c', 'contract.json', json => { const contract = JSON.parse(json); return JSON.stringify({ ...contract, required: [...contract.required, 'contributor-unknown-v9'] }); });
  expect(stack.frontendEnv, 'E2E_APP_HOLDS_NO_CREDENTIALS').toEqual({ HOST: '127.0.0.1', PORT: expect.any(String), RELEASES_ROOT: expect.any(String) });
  const proto = stack.protoPids();
  const entry = () => payee.evaluate(async () => { const r = await fetch('/', { cache: 'no-store' }); return { status: r.status, body: await r.text() }; });

  await signInPayee(payee, stack);
  await expect(payee).toHaveTitle(titleOf(original));
  const filed = await fileInvoice(payee, 'Independent release journey');
  expect(filed.response.status).toBe('waiting');
  const id = stack.records().invoices[0].id;

  // Outage: the open page keeps reading records from Proto; new page loads refuse truthfully.
  await stack.stopFrontend();
  await payee.getByRole('button', { name: 'Check invoice status again' }).click();
  await expect(payee.getByText(/Waiting for approval/)).toBeVisible();
  const down = await entry();
  expect(down.status).toBe(503);
  expect(JSON.parse(down.body).error).toMatch(/do not replace an unknown submission/);

  // Each active release's /skill.md, read with no cookie or authorization: its own declared skill, or 404.
  const declaresSkill = dir => Boolean(JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8')).entries?.['/skill.md']);
  const anonymousSkill = () => new Promise((resolve, reject) => {
    const target = new URL('/skill.md', stack.invoices), send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(target, { rejectUnauthorized: false }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })); });
    req.on('error', reject); req.end();
  });
  const expectAnonymousSkill = async (dir, label) => expect(await anonymousSkill(), `${label}: anonymous /skill.md`)
    .toEqual(declaresSkill(dir) ? { status: 200, body: readFileSync(join(dir, 'skill.md'), 'utf8') } : { status: 404, body: expect.any(String) });

  // Compatible release: new presentation, same Proto session and invoice identity, no sign-in.
  await stack.releaseFrontend(compatible);
  await expectAnonymousSkill(compatible, 'compatible release');
  await payee.reload();
  await expect(payee).toHaveTitle(titleOf(compatible));
  // With the shared release server, an open release-A page still loads A's hashed assets after B is active.
  // The bytes are release A's own file, not a fallback page or another release's bundle.
  for (const asset of aAssets) expect(await payee.evaluate(async path => { const r = await fetch(path); return { status: r.status, body: await r.text() }; }, asset), asset)
    .toEqual({ status: 200, body: readFileSync(join(original, asset.replace(/^\/invoice-ui\//, '')), 'utf8') });
  await expect(payee.getByRole('button', { name: 'Sign in with NEAR' })).toBeHidden();
  await expect(payee.getByText(/Waiting for approval/)).toBeVisible();

  await signInOwner(owner, stack);
  await owner.getByRole('link').filter({ hasText: 'Review payment' }).first().click();
  await owner.getByRole('button', { name: 'Sign approval', exact: true }).click();
  await owner.getByRole('button', { name: 'Continue to wallet', exact: true }).click();
  await expect.poll(() => Object.values(stack.ownerRecords()).some(r => r.ownerSucceeded === true)).toBe(true);
  await payee.getByRole('button', { name: 'Check invoice status again' }).click();
  await expect(payee.getByText(/Settlement is not yet confirmed/)).toBeVisible();
  stack.simulated.settle();
  await payee.getByRole('button', { name: 'Check invoice status again' }).click();
  await expect(payee.getByText(/^Paid\.$/)).toBeVisible();

  // Incompatible release is refused before any HTML is served; records are untouched. The release server is up and
  // serving C's contract (with the unknown capability), so the refusal is the compatibility check, not an outage.
  await stack.releaseFrontend(incompatible);
  expect((await entry()).status).toBe(503);
  const served = await (await fetch(`http://127.0.0.1:${stack.frontendEnv.PORT}/contract.json`)).json();
  expect(served.required, "C's contract is the one served").toContain('contributor-unknown-v9');
  await expect.poll(() => stack.records().payments[0].status).toBe('SUCCESS');

  // UI rollback restores presentation only; backend records are neither deleted nor replayed.
  await stack.releaseFrontend(original);
  await payee.reload();
  await expect(payee).toHaveTitle(titleOf(original));
  await expect(payee.getByText(/^Paid\.$/)).toBeVisible();
  await expectAnonymousSkill(original, 'rollback');
  const final = stack.records();
  expect(final.invoices.map(i => i.id)).toEqual([id]);
  expect(stack.simulated.transfers).toHaveLength(1);
  expect(stack.simulated.requests.filter(r => r.path === '/v1/submit-intent')).toHaveLength(1);
  expect(stack.protoPids(), 'E2E_NO_PROTO_RESTART').toEqual(proto);
});
