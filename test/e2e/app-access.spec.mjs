import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appClient } from '../../src/contract/app-client.ts';
import { consentMessage, setupMessage } from '../../src/contract/app-consent.ts';
import { environment } from './environment.mjs';
import { BUILDER, OWNER, PUBLIC_KEY, USDC, sign } from './provider.mjs';
import { browserContext } from './wallet.mjs';

// An app deployment's server reaching the platform on the real stack: an operator-issued service credential, owner
// consents and a hosted setup signed by the simulated wallet, then reads and owner actions through /apps/v1 with
// the SDK's appClient. Provider, chain, signatures and settlement are simulated; the provider signs edits to
// provider-enforced policy fields as NEP-366, per its docs (not observed).
const localFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), rejectUnauthorized: false }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  }); req.on('error', reject); req.end(options.body);
});
const later = days => new Date(Date.now() + days * 86_400_000).toISOString();
const value = result => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; };

/** The operator issues a deployment credential; the app's client, the owner's simulated wallet and an owner step. */
async function connect(stack) {
  const host = new URL(stack.dashboard).host, gateway = join(stack.directory, 'gateway');
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '../../src/app-credential.ts'), 'issue', 'local', host],
    { cwd: gateway, env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS } });
  const token = stdout.trim().split('\n').at(-1);
  expect(token).toMatch(/^tap_/);
  const app = appClient({ base: stack.dashboard, credential: token, fetch: localFetch });
  const ownerSigned = async message => {
    const nonce = randomBytes(32).toString('base64'), signed = await sign(OWNER, { message, recipient: host, nonce });
    return { message, nonce, publicKey: signed.publicKey, signature: signed.signature };
  };
  const ownerStep = async (agent, action) => {
    const prepared = value(await agent.call('owner/prepare', { action, signer: 'wallet' }));
    expect(prepared.intent.standard).toBe('nep413');
    const signed = await sign(OWNER, prepared.intent.payload);
    value(await agent.call('owner/submit', { correlationId: prepared.correlationId, signedData: { ...prepared.intent, public_key: signed.publicKey, signature: signed.signature } }));
    await expect.poll(async () => value(await agent.call('owner/status', { correlationId: prepared.correlationId })).status).toBe('SUCCESS');
    return prepared;
  };
  /** The owner's consent for one Organization's agent, naming its current provider ID. */
  const consent = async (organization, agent, scopes) => value(await app.consents.submit(await ownerSigned(consentMessage({ host, deployment: 'local',
    organization, owner: OWNER, agent, agentId: value(await app.identity(agent)).agentId, scopes, expiresAt: later(90) }))));
  /** A signed setup of the Organization's own hosted agent, created by the owner through the setup consent. */
  const hostedAgent = async (organization, area) => {
    const { agent: name } = value(await app.setup(await ownerSigned(setupMessage({ host, deployment: 'local', organization, owner: OWNER, area, expiresAt: later(1 / 48) }))));
    await expect.poll(async () => (await app.identity(name)).value?.created, { timeout: 30_000 }).toBe(false);
    await ownerStep(app.agent(organization, name), { type: 'agent_create', owner: { type: 'near', account_id: OWNER, public_key: PUBLIC_KEY }, role: area === 'payables' ? 'payout' : 'treasury' });
    return name;
  };
  return { host, gateway, app, ownerSigned, ownerStep, consent, hostedAgent };
}

test('an app server relays readable owner actions, sends NEP-366 ones to the platform confirm page, and sets up a hosted agent', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { secondAccount: true, accounts: [BUILDER], onChainPolicyEdits: true });
  const steps = [];
  try {
    // The operator issues the deployment's service credential on the platform host.
    const { host, gateway, app, ownerSigned, ownerStep } = await connect(stack);
    const intents = () => stack.simulated.requests.filter(r => r.path === '/v1/generate-intent').length;

    // 1. The configured payout agent: identity, then the owner's consent for reads and owner actions.
    const identity = value(await app.identity('payout'));
    expect(identity).toMatchObject({ agent: 'payout', owner: OWNER, agentId: stack.simulated.id, created: true, deployment: 'local' });
    value(await app.consents.submit(await ownerSigned(consentMessage({ host, deployment: 'local', organization: 'org_1',
      owner: OWNER, agent: 'payout', agentId: identity.agentId, scopes: ['owner', 'read'], expiresAt: later(90) }))));
    const payout = app.agent('org_1', 'payout');
    const overview = value(await payout.call('overview'));
    expect(overview.policy.revision).toBe(1);
    expect(typeof overview.book[0].confidential, 'holdings arrive as bigint').toBe('bigint');
    steps.push('consent for the payout agent; overview read through the app route');

    // 2. Platform-built: freeze and unfreeze.
    await ownerStep(payout, { type: 'agent_freeze' });
    expect(stack.simulated.payoutPolicy().policy.frozen).toBe(true);
    await ownerStep(payout, { type: 'agent_unfreeze' });
    expect(stack.simulated.payoutPolicy().policy.frozen).toBe(false);
    steps.push('freeze and unfreeze, each signed by the owner');

    // 3. Readable policy edits: a payee added to a non-empty list, then the budget.
    const reviewed = async () => { const o = value(await payout.call('overview')); return { revision: o.policy.revision, digest: o.digest }; };
    const payees = stack.simulated.payoutPolicy().policy.destinations.list.map(({ address, confidential }) => ({ address, confidential }));
    await ownerStep(payout, { type: 'policy_update', expectedPolicy: await reviewed(), changes: { destinations: [...payees, { address: BUILDER, confidential: true }] } });
    expect(stack.simulated.payoutPolicy().policy.destinations.list.map(d => d.address)).toContain(BUILDER);
    await ownerStep(payout, { type: 'policy_update', expectedPolicy: await reviewed(), changes: { budget: { daily_usd: '40', weekly_usd: null, monthly_usd: '150' } } });
    expect(stack.simulated.payoutPolicy()).toMatchObject({ revision: 3, policy: { budget: { daily_usd: '40', monthly_usd: '150' } } });
    steps.push('destination and budget edits (NEP-413), each signed by the owner');

    // 4. Refused before the agent: payees at creation, DAO signing.
    const before = intents();
    for (const input of [{ action: { type: 'agent_create', owner: { type: 'near', account_id: OWNER, public_key: PUBLIC_KEY }, role: 'payout', payees: [BUILDER] }, signer: 'wallet' },
      { action: { type: 'agent_freeze' }, signer: 'dao' }])
      expect(await payout.call('owner/prepare', input), JSON.stringify(input.action)).toMatchObject({ ok: false, kind: 'forbidden', source: 'gateway' });
    expect(intents(), 'nothing refused reached the provider').toBe(before);
    steps.push('payees at creation and the DAO signer refused before the agent');

    // 5. A provider-enforced edit (`owner_approval` off) comes back NEP-366: the app gets only a confirm link, and the
    //    owner signs it on the platform's page, which shows the platform's record of the edit.
    const held = value(await payout.call('owner/prepare', { action: { type: 'policy_update', expectedPolicy: await reviewed(), changes: { owner_approval: false } }, signer: 'wallet' }));
    expect(stack.simulated.intents.at(-1).intent.standard).toBe('nep366');
    expect(held.intent, 'the app never holds the delegate bytes').toBeUndefined();
    expect(held.confirm.url.slice(`https://${host}/confirm/`.length)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(held.confirm.url.startsWith(`https://${host}/confirm/`)).toBe(true);
    // The app holds the link too: it reads the terms there, never the bytes, and can't submit the action itself.
    const linkView = await (await localFetch(held.confirm.url.replace('/confirm/', '/confirm/v1/'))).json();
    expect(linkView).toMatchObject({ type: 'policy_update', state: 'open', policy: { current: { owner_approval: true }, requested: { owner_approval: false } } });
    expect(linkView.intent).toBeUndefined();
    expect(await payout.call('owner/submit', { correlationId: held.correlationId, signedData: { standard: 'nep366' } }))
      .toMatchObject({ ok: false, kind: 'forbidden', source: 'gateway' });
    const wallet = await browserContext(browser, stack, OWNER);
    try {
      const page = await wallet.context.newPage();
      await page.goto(held.confirm.url);
      await expect(page.getByRole('heading', { name: "Change the agent's policy" })).toBeVisible();
      await expect(page.getByText('owner_approval', { exact: true })).toBeVisible();
      await expect(page.getByText('After signing')).toBeVisible();
      await expect(page.getByText(/App deployment local asks owner\.near/)).toBeVisible();
      // The owner's wallet may already be connected; otherwise connect it, choosing it if near-connect asks.
      const sign = page.getByRole('button', { name: 'Sign and submit' }), connect = page.getByRole('button', { name: `Connect ${OWNER}` });
      await expect(sign.or(connect)).toBeVisible();
      if (await connect.isVisible()) {
        await connect.click();
        const chooser = page.getByText('Local test wallet', { exact: true });
        await Promise.race([chooser.waitFor().then(() => chooser.click()).catch(() => {}), sign.waitFor()]);
      }
      await sign.click();
      await expect(page.getByText(/Submitted\. The app follows the outcome/)).toBeVisible();
      expect(wallet.signatures.filter(s => s.delegate)).toHaveLength(1);
      expect(wallet.signatures.filter(s => !s.delegate).map(s => s.message.split('\n')[0]), 'first the link\'s readable text').toEqual(['Open a MultiAgency confirm page.']);
    } finally { await wallet.context.close(); }
    await expect.poll(async () => value(await payout.call('owner/status', { correlationId: held.correlationId })).status).toBe('SUCCESS');
    expect(stack.simulated.payoutPolicy()).toMatchObject({ revision: 4, policy: { owner_approval: false } });
    const log = readFileSync(join(gateway, '.app-access/access.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(log.filter(l => ['confirm', 'confirmed'].includes(l.event)).map(l => [l.event, l.correlationId])).toEqual([['confirm', held.correlationId], ['confirmed', held.correlationId]]);
    steps.push("a NEP-366 edit reached the app only as a confirm link; the owner signed it on the platform's page and it applied");

    // 6. Hosted setup: the owner's signed setup reserves this Organization's own payables agent, beside the owner's
    //    configured one; the setup consent relays its creation.
    const setup = value(await app.setup(await ownerSigned(setupMessage({ host, deployment: 'local', organization: 'org_1',
      owner: OWNER, area: 'payables', expiresAt: later(1 / 48) }))));
    expect(setup).toMatchObject({ consent: { agentId: 'unborn', scopes: ['owner'] } });
    const name = setup.agent, hosted = app.agent('org_1', name);
    expect(name).not.toBe('payout');
    expect(await app.agent('org_2', name).call('owner/status', { correlationId: 'c' }), 'another Organization reaches nothing (the offline test isolates the Organization rule)').toMatchObject({ ok: false, kind: 'forbidden' });
    await expect.poll(async () => (await app.identity(name)).value?.created, { timeout: 30_000 }).toBe(false);
    await ownerStep(hosted, { type: 'agent_create', owner: { type: 'near', account_id: OWNER, public_key: PUBLIC_KEY }, role: 'payout' });
    const created = value(await app.identity(name));
    expect(created).toMatchObject({ created: true, agentId: stack.simulated.created()[0] });
    expect(await hosted.call('overview'), 'the setup consent reads nothing').toMatchObject({ ok: false, kind: 'forbidden' });
    steps.push("hosted setup of the Organization's own payables agent, then its creation (no payees) signed by the owner");

    // 7. The owner's consent for the created agent takes over: a grant, readable, signed by the owner.
    value(await app.consents.submit(await ownerSigned(consentMessage({ host, deployment: 'local', organization: 'org_1',
      owner: OWNER, agent: name, agentId: created.agentId, scopes: ['owner', 'read'], expiresAt: later(90) }))));
    await ownerStep(hosted, { type: 'grant_issue', label: 'invoices' });
    const grants = stack.simulated.requests.filter(r => r.path === '/v1/generate-intent' && r.body.type === 'grant_issue');
    expect(grants.at(-1).body).toMatchObject({ agent_id: created.agentId, label: 'invoices' });
    steps.push('consent for the created agent; grant signed by the owner');

    expect(stack.simulated.errors).toEqual([]);
    expect(stack.simulated.transfers, 'no money moved').toEqual([]);
  } finally {
    await info.attach('steps', { body: JSON.stringify(steps, null, 2), contentType: 'application/json' });
    await stack.close();
  }
});

test('an app requests a payout once under its requestId, follows it by requestId, and a lost reply is never resent', async ({}, info) => {
  test.setTimeout(180_000);
  // The payout agent starts with transfers on and no payees, so its first payee changes only `destinations`: NEP-413 per
  // the provider's docs, relayed by the app. The first test shows an on-chain edit going through the confirm page.
  const stack = await environment(info.outputPath('environment'), { secondAccount: true, accounts: [BUILDER] });
  const steps = [];
  try {
    const { app, ownerStep, consent, hostedAgent } = await connect(stack);
    const name = await hostedAgent('org_1', 'payables');
    const created = value(await app.identity(name)).agentId;
    await consent('org_1', name, ['owner', 'payout', 'read']);
    const agent = app.agent('org_1', name);
    await ownerStep(agent, { type: 'grant_issue', label: 'invoices' });
    const reviewed = async () => { const o = value(await agent.call('overview')); return { revision: o.policy.revision, digest: o.digest }; };
    await ownerStep(agent, { type: 'policy_update', expectedPolicy: await reviewed(), changes: { destinations: [{ address: BUILDER, confidential: true }] } });
    const deposit = value(await agent.call('deposit'));
    expect(deposit.address, 'the app takes a deposit address to fund the agent').toBeTruthy();
    stack.simulated.fund(created, 10_000_000n);
    steps.push("setup: the Organization's own payout agent, its grant and payee (owner signatures), a deposit address through the app, and funding (simulated)");

    const ask = async (requestId, amount = '2000000') =>
      agent.call('payouts/request', { requestId, asset: USDC, delivery: 'intents', recipient: BUILDER, amount, expectedPolicy: await reviewed() });
    const first = value(await ask('wo-1'));
    expect(first).toMatchObject({ requestId: 'wo-1', state: 'held' });
    expect(stack.simulated.transfers).toHaveLength(1);
    expect(value(await ask('wo-1'))).toEqual(first);
    expect(value(await agent.call('payouts/status', { requestId: 'wo-1' }))).toMatchObject({ state: 'held', correlationId: first.correlationId });
    expect(await ask('wo-1', '3000000')).toMatchObject({ ok: false, kind: 'refused', code: 'request_conflict' });
    expect(stack.simulated.transfers, 'asking again, reading or changing terms sends nothing').toHaveLength(1);
    expect(value(await agent.call('held')).map(h => h.correlationId)).toContain(first.correlationId);
    steps.push('one request held for the owner; asked again and read by requestId without a second send; other terms refused');

    // Another request with the same payee and amount, while the first waits: refused before sending (duplicate held payout).
    expect(value(await ask('wo-2'))).toMatchObject({ requestId: 'wo-2', state: 'refused', code: 'duplicate_held_payout' });
    expect(stack.simulated.transfers).toHaveLength(1);
    steps.push('a second request with the same payee and amount, while the first is held, is refused before sending');

    // The owner's vote, relayed by the app: prepared with the payout's terms as the platform proved them, signed by the
    // owner; the provider settles the released payout (simulated) and nothing is sent again.
    const { approvalId } = value(await agent.call('held')).find(h => h.correlationId === first.correlationId);
    const vote = value(await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId, verdict: 'approve', correlationId: first.correlationId }, signer: 'wallet' }));
    expect(vote.payment).toEqual({ correlationId: first.correlationId, verdict: 'approve', terms: { recipient: BUILDER, asset: USDC, amount: '2000000' } });
    expect(vote.intent.standard).toBe('nep413');
    const signed = await sign(OWNER, vote.intent.payload);
    value(await agent.call('owner/submit', { correlationId: vote.correlationId, signedData: { ...vote.intent, public_key: signed.publicKey, signature: signed.signature } }));
    stack.simulated.settle(first.correlationId);
    await expect.poll(async () => value(await agent.call('payouts/status', { requestId: 'wo-1' })).state).toBe('succeeded');
    expect(stack.simulated.transfers).toHaveLength(1);
    steps.push("the owner's vote, relayed by the app with the proven terms, released the held payout once");

    // A withdrawal to chain near (P3b): the owner agrees a withdrawal payee through the app, the request is held for the
    // owner, approving it is refused until a held withdrawal's approval is verified, and rejecting it ends it unpaid.
    await ownerStep(agent, { type: 'policy_update', expectedPolicy: await reviewed(), changes: { withdrawals: [{ address: BUILDER }] } });
    expect(stack.simulated.payoutPolicy(created).policy).toMatchObject({ actions: ['transfer', 'withdraw'] });
    const withdrawn = value(await agent.call('payouts/request', { requestId: 'wd-1', asset: USDC, delivery: { chain: 'near' }, recipient: BUILDER,
      amount: '500000', expectedPolicy: await reviewed() }));
    expect(withdrawn).toMatchObject({ requestId: 'wd-1', state: 'held' });
    const heldWithdrawal = stack.simulated.transfers.find(p => p.type === 'withdraw');
    expect(heldWithdrawal.body).toEqual({ asset: USDC, amount: '500000', chain: 'near', recipient: BUILDER, confidential: true });
    const pending = value(await agent.call('held')).find(h => h.correlationId === withdrawn.correlationId);
    const approve = await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId: pending.approvalId, verdict: 'approve', correlationId: withdrawn.correlationId }, signer: 'wallet' });
    expect(approve.ok, 'approving a held withdrawal is refused').toBe(false);
    // A vote's status follows the payout it decides: a rejected one ends FAILED.
    const reject = value(await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId: pending.approvalId, verdict: 'reject', correlationId: withdrawn.correlationId }, signer: 'wallet' }));
    expect(reject.payment).toEqual({ correlationId: withdrawn.correlationId, verdict: 'reject', terms: null });
    const rejected = await sign(OWNER, reject.intent.payload);
    value(await agent.call('owner/submit', { correlationId: reject.correlationId, signedData: { ...reject.intent, public_key: rejected.publicKey, signature: rejected.signature } }));
    await expect.poll(async () => value(await agent.call('owner/status', { correlationId: reject.correlationId })).status).toBe('FAILED');
    await expect.poll(async () => value(await agent.call('payouts/status', { requestId: 'wd-1' })).state).toBe('failed');
    expect(heldWithdrawal.failure).toBe('rejected_by_owner');
    steps.push('a withdrawal to chain near was held for the owner; approving it was refused, and the rejection ended it unpaid');

    // A lost reply: the provider accepted the transfer, and its answer never arrived.
    stack.simulated.dropTransferResponse();
    expect(value(await ask('wo-3', '1000000'))).toMatchObject({ requestId: 'wo-3', state: 'unknown' });
    const accepted = stack.simulated.transfers.length;
    expect(stack.simulated.transfers.filter(p => p.type !== 'withdraw')).toHaveLength(2);
    expect(value(await ask('wo-3', '1000000'))).toMatchObject({ state: 'unknown' });
    expect(await ask('wo-4', '500000')).toMatchObject({ ok: false, kind: 'unresolved' });
    expect(stack.simulated.transfers, 'a lost request is never resent, and blocks new ones until resolved').toHaveLength(accepted);
    steps.push('a lost reply reads unknown, is never resent, and blocks new requests');
    expect(stack.simulated.errors).toEqual([]);
  } finally {
    await info.attach('steps', { body: JSON.stringify(steps, null, 2), contentType: 'application/json' });
    await stack.close();
  }
});
