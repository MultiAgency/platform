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

test('an app server reads and relays only readable or platform-built owner actions, and sets up a hosted agent', async ({}, info) => {
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

    // 4. Refused before the agent: provider-enforced edits, payees at creation, held-payout votes, DAO signing.
    const before = intents();
    for (const input of [{ action: { type: 'policy_update', expectedPolicy: await reviewed(), changes: { owner_approval: false } }, signer: 'wallet' },
      { action: { type: 'agent_create', owner: { type: 'near', account_id: OWNER, public_key: PUBLIC_KEY }, role: 'payout', payees: [BUILDER] }, signer: 'wallet' },
      { action: { type: 'approval_vote', approvalId: crypto.randomUUID(), verdict: 'approve', correlationId: 'c' }, signer: 'wallet' },
      { action: { type: 'agent_freeze' }, signer: 'dao' }])
      expect(await payout.call('owner/prepare', input), JSON.stringify(input.action)).toMatchObject({ ok: false, kind: 'forbidden', source: 'gateway' });
    expect(intents(), 'nothing refused reached the provider').toBe(before);
    steps.push('provider-enforced edit, payees at creation, approval vote and DAO signer refused before the agent');

    // 5. Removing the last payee also turns transfers off (provider-enforced `actions`): the provider makes it NEP-366,
    //    so the prepared intent is withheld and the policy is unchanged.
    expect(await payout.call('owner/prepare', { action: { type: 'policy_update', expectedPolicy: await reviewed(), changes: { destinations: [] } }, signer: 'wallet' }))
      .toMatchObject({ ok: false, kind: 'forbidden', source: 'gateway' });
    expect(intents(), 'the agent did prepare it').toBe(before + 1);
    expect(stack.simulated.intents.at(-1).intent.standard).toBe('nep366');
    expect(stack.simulated.payoutPolicy().revision).toBe(3);
    const log = readFileSync(join(gateway, '.app-access/access.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(log.filter(l => l.event === 'withheld')).toEqual([expect.objectContaining({ action: 'policy_update', correlationId: stack.simulated.intents.at(-1).correlation_id })]);
    steps.push('a destinations edit the provider made NEP-366 was withheld and logged');

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
  // Policy edits stay NEP-413 in this environment, so the Organization's first payee is a fixture step here. Per the
  // provider's docs that edit is signed on chain, which an app can't relay (the first test shows it withheld); the owner
  // signs it on the platform.
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
    stack.simulated.fund(created, 10_000_000n);
    steps.push("setup: the Organization's own payout agent, its grant and payee (owner signatures) and funding (simulated)");

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

    // A lost reply: the provider accepted the transfer, and its answer never arrived.
    stack.simulated.dropTransferResponse();
    expect(value(await ask('wo-3', '1000000'))).toMatchObject({ requestId: 'wo-3', state: 'unknown' });
    const accepted = stack.simulated.transfers.length;
    expect(accepted).toBe(2);
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
