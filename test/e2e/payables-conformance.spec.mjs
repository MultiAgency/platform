import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { environment } from './environment.mjs';
import { browserContext, connectWallet } from './wallet.mjs';
import { OWNER, PAYEE, USDC, sign } from './provider.mjs';
import { clientConformance } from './conformance.mjs';

// M4 runtime conformance for Payables' listed procedures (see `clientConformance`), on the payout agent the gateway
// serves: approve-only, as in production (its executor is the invoice host). Error kinds are forced where reachable.
const READ = ['setup', 'instance', 'overview', 'policyHistory', 'activity', 'unresolved', 'held', 'inbox/list', 'autopilot/get', 'autopilot/evidence', 'autopilot/log',
  'strategy/get', 'treasury/get', 'ledgerCsv', 'reconcileBooks', 'paymentHistory', 'paymentStatus', 'invoices', 'agreements/list', 'owner/status', 'owner/pending',
  'owner/actions', 'compensation/list', 'workOrders/list', 'workOrders/get', 'workOrders/status'];
const MUTATE = ['pay', 'deposit', 'recover', 'cancelPreparedInvoice', 'inbox/dismiss', 'owner/prepare', 'owner/submit', 'agreements/propose', 'agreements/offer',
  'agreements/decline', 'compensation/agreement', 'compensation/review', 'compensation/prepare', 'compensation/send', 'workOrders/create', 'workOrders/prepare',
  'workOrders/submit', 'workOrders/deposit', 'workOrders/file', 'strategy/save', 'autopilot/enable', 'autopilot/stop', 'autopilot/tick', 'treasury/link',
  'treasury/unlink', 'treasury/setConfidential', 'treasury/fund'];
const STREAM = ['rebalance', 'executePlan', 'sweep', 'steward/propose'];
const LISTED = [...READ, ...MUTATE, ...STREAM];
const until = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

test('Payables: every listed procedure through ownerClient equals its raw answer, with each reachable error kind', async ({ browser }, info) => {
  test.setTimeout(300_000);
  expect(LISTED).toHaveLength(57);
  const stack = await environment(info.outputPath('environment'));
  const owner = await browserContext(browser, stack, OWNER), payeeBrowser = await browserContext(browser, stack, PAYEE);
  try {
    const page = await owner.context.newPage();
    await page.goto(`${stack.dashboard}/a/payout/`);
    await connectWallet(page, OWNER);
    const { client, check, outage, accepted, report } = clientConformance(page, '/a/payout', LISTED);
    /** Prepare, sign the exact prepared intent, submit once and follow it, through ownerClient. */
    const signAndSubmit = async (prepareProcedure, input, submitProcedure, identity = {}) => {
      const prepared = await check(prepareProcedure, input, 'ok');
      const signed = await sign(OWNER, prepared.value.intent.payload);
      await check(submitProcedure, { ...identity, correlationId: prepared.value.correlationId, signedData: { ...prepared.value.intent, public_key: signed.publicKey, signature: signed.signature } }, 'ok');
      return prepared.value.correlationId;
    };

    // Reads.
    for (const procedure of READ.filter(p => !['autopilot/evidence', 'autopilot/log', 'paymentStatus', 'owner/status', 'workOrders/get', 'workOrders/status'].includes(p)))
      await check(procedure, undefined, 'ok');
    await check('autopilot/evidence', {}, 'ok');

    // Owner-signed agent control: freeze, then unfreeze.
    for (const type of ['agent_freeze', 'agent_unfreeze']) {
      const correlationId = await signAndSubmit('owner/prepare', { action: { type }, signer: 'wallet' }, 'owner/submit');
      await expect.poll(async () => (await check('owner/status', { correlationId })).value?.status).toBe('SUCCESS');
    }

    // The payee's session on the invoice host.
    const payee = await payeeBrowser.context.newPage();
    await payee.goto(stack.invoices);
    await payee.getByRole('button', { name: 'Sign in with NEAR' }).click();
    const chooser = payee.getByText('Local test wallet', { exact: true }); await chooser.waitFor(); await chooser.click();
    await expect(payee.getByRole('button', { name: 'Submit invoice', exact: true })).toBeVisible();
    // The payee files an invoice: the payout agent's own held payment.
    await payee.getByLabel('Amount (USDC)').fill('1.25');
    const filed = payee.waitForResponse(r => r.url().endsWith('/api/invoices') && r.request().method() === 'POST');
    await payee.getByRole('button', { name: 'Submit invoice', exact: true }).click();
    expect((await filed).ok()).toBe(true);
    const [invoicePayment] = stack.simulated.transfers;
    await check('paymentStatus', { correlationId: invoicePayment.correlation }, 'ok');
    const payeePost = path => payee.evaluate(async path => (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, path);

    // A purchase order: create, owner authorization, exact funding, the payee files, the held payout is observed.
    const id = randomUUID();
    await check('workOrders/create', { id, payee: PAYEE, amount: '3000000', note: 'Conformance order', until: until() }, 'ok');
    await check('workOrders/get', { id }, 'ok');
    const created = await signAndSubmit('workOrders/prepare', { id, action: 'create', signer: 'wallet' }, 'workOrders/submit', { id });
    await expect.poll(async () => (await check('workOrders/status', { id, correlationId: created })).value?.status).toBe('SUCCESS');
    // Funding before the grant: the executor's refusal reaches the owner through the approve-only host. Nothing is sent.
    await check('workOrders/deposit', { id }, 'refused');
    expect(stack.simulated.transfers).toHaveLength(1);
    const granted = await signAndSubmit('workOrders/prepare', { id, action: 'grant', signer: 'wallet' }, 'workOrders/submit', { id });
    await expect.poll(async () => (await check('workOrders/status', { id, correlationId: granted })).value?.status).toBe('SUCCESS');
    await check('workOrders/deposit', { id }, 'ok');
    await check('workOrders/file', { id }, 'refused'); // not yet funded: refused, nothing sent
    expect(stack.simulated.transfers).toHaveLength(1);
    stack.simulated.fund(stack.simulated.created().at(-1), 3_000_000n);
    expect(await payeePost(`/api/work-orders/${id}/file`)).toBe(200);
    await check('workOrders/file', { id }, 'ok'); // filed already: the existing payment, nothing new
    expect(stack.simulated.transfers).toHaveLength(2);

    // Contribution report: the owner records an agreement, the payee reports, the owner reviews and prepares it.
    const agreementId = randomUUID(), requestId = randomUUID();
    await check('compensation/agreement', { commandId: randomUUID(), id: agreementId, expectedVersion: 0, terms: { payee: PAYEE, title: 'Conformance sponsorship',
      document: 'https://example.test/agreement', signedOn: '2026-10-01', start: '2026-10-01', end: '2026-10-31', ceiling: '10000000', openingApproved: '0', scope: 'Conformance' } }, 'ok');
    const reported = await payee.evaluate(async body => (await fetch('/api/compensation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status,
      { commandId: randomUUID(), id: requestId, expectedVersion: 0, submit: true,
        report: { agreementId, start: '2026-10-01', end: '2026-10-15', contributions: 'Hosted the meetup', assessment: 'Delivered as agreed', evidence: [] } });
    expect(reported).toBe(200);
    const version = async () => (await client.call('compensation/list')).value.requests.find(r => r.id === requestId).version;
    await check('compensation/review', { commandId: randomUUID(), id: requestId, expectedVersion: await version(), decision: 'approved', approvedAmount: '2000000', feedback: 'Approved' }, 'ok');
    await check('compensation/prepare', { type: 'prepare', command: { commandId: randomUUID(), id: requestId, expectedVersion: await version(), mode: 'isolated', until: until() } }, 'ok');

    // Agreements offered by the owner.
    const offered = await check('agreements/offer', { payee: PAYEE, amount: '1000000', note: 'Conformance offer', until: until() }, 'ok');
    await check('agreements/propose', { id: offered.value.id, until: until() }, undefined);
    await check('agreements/decline', { id: offered.value.id }, undefined);

    // Money actions and agent settings on an approve-only copy, plus the remaining procedures.
    const overview = (await client.call('overview')).value;
    const expectedPolicy = { revision: overview.policy.revision, digest: overview.digest };
    // An approve-only copy refuses to send before recording anything.
    const sent = stack.simulated.transfers.length;
    await check('pay', { recipient: PAYEE, asset: USDC, amount: '1000000', confidential: true, expectedPolicy }, 'refused');
    expect(stack.simulated.transfers).toHaveLength(sent);
    await check('compensation/send', { type: 'send', id: requestId, expectedPolicy }, undefined);
    await check('paymentStatus', { correlationId: randomUUID() }, undefined);
    await check('autopilot/log', { tickId: randomUUID() }, 'refused');
    await check('cancelPreparedInvoice', { id: '0'.repeat(32) }, 'refused'); // no such invoice
    await check('inbox/dismiss', { id: randomUUID() }, undefined);
    for (const procedure of ['deposit', 'recover', 'autopilot/stop', 'autopilot/tick', 'rebalance']) await check(procedure, undefined, undefined);
    const strategy = (await client.call('strategy/get')).value;
    await check('strategy/save', { strategy: strategy.strategy, expectedDigest: strategy.digest }, undefined);
    await check('autopilot/enable', { expectedDigest: strategy.digest }, undefined);
    await check('treasury/link', { accountId: OWNER }, undefined);
    await check('treasury/setConfidential', { confidential: true }, undefined);
    await check('treasury/fund', { asset: 'USDC', amount: '1000000' }, undefined);
    await check('treasury/unlink', undefined, undefined);
    await check('executePlan', { planId: randomUUID() }, 'refused');
    await check('sweep', { execute: false }, undefined);
    await check('sweep', { execute: true }, undefined);
    await check('steward/propose', {}, undefined);

    // refused: invalid input never reaches a handler.
    for (const [procedure, input] of [['pay', { recipient: PAYEE }], ['paymentStatus', { correlationId: '' }], ['cancelPreparedInvoice', { id: 'x' }], ['inbox/dismiss', { id: 'x' }],
      ['owner/prepare', { action: { type: 'nope' }, signer: 'wallet' }], ['owner/submit', { correlationId: '', signedData: {} }], ['owner/status', { correlationId: 5 }],
      ['agreements/propose', { id: 'x', until: 'soon' }], ['agreements/offer', { payee: PAYEE }], ['agreements/decline', { id: 'x' }],
      ['compensation/agreement', { id: 'x' }], ['compensation/review', { id: 'x' }], ['compensation/prepare', { type: 'nope' }], ['compensation/send', { type: 'send', id: 'x' }],
      ['workOrders/create', { id: 'x' }], ['workOrders/get', { id: 'x' }], ['workOrders/status', { id: 'x' }], ['workOrders/prepare', { id: 'x' }], ['workOrders/submit', { id: 'x' }],
      ['workOrders/deposit', { id: 'x' }], ['workOrders/file', { id: 'x' }], ['strategy/save', { strategy: {}, expectedDigest: 'x' }], ['autopilot/enable', { expectedDigest: 'x' }],
      ['autopilot/evidence', { since: 'yesterday' }], ['autopilot/log', { tickId: '' }], ['treasury/link', { accountId: 'x' }], ['treasury/setConfidential', { confidential: 'yes' }],
      ['treasury/fund', { asset: 'DOGE', amount: '1' }], ['executePlan', { planId: 'x' }], ['sweep', { execute: 'yes' }], ['steward/propose', { instruction: 'x'.repeat(3000) }]])
      await check(procedure, input, 'refused');

    // busy: another holder has this agent's money lock.
    const release = await lockfile.lock(join(stack.directory, 'reviewer/.ops', `${stack.simulated.id}.jsonl`), { realpath: false, stale: 10_000, retries: 0 });
    try {
      for (const [procedure, input] of [['pay', accepted.pay ?? { recipient: PAYEE, asset: USDC, amount: '1000000', confidential: true, expectedPolicy }], ['recover', undefined], ['sweep', { execute: true }]])
        await check(procedure, input, 'busy');
    } finally { await release(); }

    // provider: the provider is unavailable. Each case repeats a valid input; procedures this approve-only payout host
    // never accepts in the normal flow have no valid input and are excluded with the reason, never counted.
    const approveOnly = 'refused on this approve-only payout host before any provider call; no valid input exists here';
    const offer = (await client.call('agreements/offer', { payee: PAYEE, amount: '1000000', note: 'Outage offer', until: until() })).value;
    await outage(stack.simulated, LISTED, {
      inputs: { 'agreements/propose': { id: offer.id, until: until() } },
      excluded: { pay: approveOnly, 'compensation/send': approveOnly, cancelPreparedInvoice: 'no never-submitted invoice exists on this fixture',
        'autopilot/log': 'the payout agent records no autopilot runs', 'autopilot/enable': 'the payout agent has no treasury strategy to enable',
        'autopilot/stop': 'the payout agent has no schedule to stop', 'strategy/save': 'the payout agent has no treasury strategy',
        rebalance: 'the payout agent has no treasury strategy', executePlan: 'no plan exists for the payout agent',
        'steward/propose': 'attested inference is not available offline' },
    });

    report(info.outputPath('coverage.json'));
  } finally {
    await owner.context.close(); await payeeBrowser.context.close(); await stack.close();
  }
});
