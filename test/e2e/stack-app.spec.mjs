import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { appClient } from '../../src/contract/app-client.ts';
import { setupMessage, consentMessage } from '../../src/contract/app-consent.ts';
import { ownerClient } from '../../src/contract/owner-client.ts';
import { OWNER, PAYEE, PUBLIC_KEY, USDC } from './provider.mjs';

// The running stack as a builder uses it (`pnpm test:e2e:stack --treasury --app <deployment>`): a separate app server
// with the startup service credential, the owner's signatures from the `signOwner` control, a payout request held for
// the owner and released by the owner's vote, and a Treasury machine credential from the `machineCredential` control.
// The behaviour behind each route is asserted in app-access.spec.mjs and agent-access.spec.mjs; this case owns the
// stack's flags, control files and state.json. Provider, chain, signatures and settlement are simulated.
const later = days => new Date(Date.now() + days * 86_400_000).toISOString();
const value = result => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; };

test('a separate app server runs a held payout and a Treasury machine read on the running stack', async ({}, info) => {
  test.setTimeout(240_000);
  const artifacts = info.outputPath('stack-run'), directory = join(artifacts, 'stack');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'stack.mjs'), '--no-browser', '--treasury', '--app', 'dao-local'],
    { env: { ...process.env, PROTO_E2E_ARTIFACTS: artifacts }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  try {
    await expect.poll(() => child.exitCode === null ? output.includes('Isolated stack ready') : `exited: ${output.slice(-2_000)}`, { timeout: 120_000 }).toBe(true);
    const state = () => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    const { dashboard, app: appState, treasury } = state(), host = new URL(dashboard).host;
    expect(appState).toMatchObject({ deployment: 'dao-local', base: dashboard });
    expect(treasury.owner, 'one owner for both agents').toBe(OWNER);
    const credential = readFileSync(appState.credentialFile, 'utf8');
    expect(credential).toMatch(/^tap_/);
    expect(readFileSync(join(directory, 'state.json'), 'utf8'), 'the token stays out of state.json').not.toContain(credential);

    const ca = readFileSync(join(directory, 'environment', 'localhost.crt'));
    const fetch = (url, options = {}) => new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), ca }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      }); req.on('error', reject); req.end(options.body);
    });
    let sequence = 0;
    /** One control file, written whole, and its answer. */
    const control = async (command, input = {}) => {
      const path = join(directory, 'controls', `c${++sequence}.json`), answer = path.replace(/\.json$/, '.result.json');
      writeFileSync(`${path}.tmp`, JSON.stringify({ command, ...input })); renameSync(`${path}.tmp`, path);
      await expect.poll(() => existsSync(answer), { timeout: 15_000 }).toBe(true);
      return JSON.parse(readFileSync(answer, 'utf8'));
    };
    const signed = async payload => {
      const answer = await control('signOwner', payload);
      if (!answer.ok) throw new Error(answer.error);
      return answer.value;
    };
    const ownerSigned = async message => {
      const nonce = randomBytes(32).toString('base64'), { publicKey, signature } = await signed({ message, recipient: host, nonce });
      return { message, nonce, publicKey, signature };
    };
    const app = appClient({ base: dashboard, credential, fetch });
    const ownerStep = async (agent, action) => {
      const prepared = value(await agent.call('owner/prepare', { action, signer: 'wallet' }));
      const { publicKey, signature } = await signed(prepared.intent.payload);
      value(await agent.call('owner/submit', { correlationId: prepared.correlationId, signedData: { ...prepared.intent, public_key: publicKey, signature } }));
      await expect.poll(async () => value(await agent.call('owner/status', { correlationId: prepared.correlationId })).status).toBe('SUCCESS');
      return prepared;
    };

    expect(await control('signOwner', { message: `Sign in to ${host}`, recipient: host, nonce: randomBytes(32).toString('base64') }),
      'the control never signs the platform sign-in text').toMatchObject({ ok: false });

    // The Organization's own payout agent: setup, creation, consent, grant and payee, all signed through the control.
    const { agent: name } = value(await app.setup(await ownerSigned(setupMessage({ host, deployment: 'dao-local', organization: 'org_1', owner: OWNER, area: 'payables', expiresAt: later(1 / 48) }))));
    await expect.poll(async () => (await app.identity(name)).value?.created, { timeout: 30_000 }).toBe(false);
    await ownerStep(app.agent('org_1', name), { type: 'agent_create', owner: { type: 'near', account_id: OWNER, public_key: PUBLIC_KEY }, role: 'payout' });
    const created = value(await app.identity(name)).agentId;
    value(await app.consents.submit(await ownerSigned(consentMessage({ host, deployment: 'dao-local', organization: 'org_1', owner: OWNER, agent: name,
      agentId: created, scopes: ['owner', 'payout', 'read'], expiresAt: later(90) }))));
    const agent = app.agent('org_1', name);
    await ownerStep(agent, { type: 'grant_issue', label: 'invoices' });
    const reviewed = async () => { const o = value(await agent.call('overview')); return { revision: o.policy.revision, digest: o.digest }; };
    await ownerStep(agent, { type: 'policy_update', expectedPolicy: await reviewed(), changes: { destinations: [{ address: PAYEE, confidential: true }] } });
    expect(await control('fund', { agent: created, amount: '10000000' })).toEqual({ ok: true });

    // One payout request, held for the owner; the vote releases it and the settle control completes it.
    const first = value(await agent.call('payouts/request', { requestId: 'dao-1', asset: USDC, delivery: 'intents', recipient: PAYEE, amount: '2000000', expectedPolicy: await reviewed() }));
    expect(first).toMatchObject({ requestId: 'dao-1', state: 'held' });
    await expect.poll(() => state().transfers.filter(t => t.agent === created).length).toBe(1);
    const { approvalId } = value(await agent.call('held')).find(h => h.correlationId === first.correlationId);
    const vote = value(await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId, verdict: 'approve', correlationId: first.correlationId }, signer: 'wallet' }));
    expect(vote.payment.terms).toEqual({ recipient: PAYEE, asset: USDC, amount: '2000000' });
    const approval = await signed(vote.intent.payload);
    value(await agent.call('owner/submit', { correlationId: vote.correlationId, signedData: { ...vote.intent, public_key: approval.publicKey, signature: approval.signature } }));
    expect(await control('settle', { correlation: first.correlationId })).toEqual({ ok: true });
    await expect.poll(async () => value(await agent.call('payouts/status', { requestId: 'dao-1' })).state).toBe('succeeded');
    expect(state().transfers.filter(t => t.agent === created), 'released once, never sent again').toHaveLength(1);

    // The Treasury owner's machine credential, read-only, used by a server.
    const issued = await control('machineCredential', { label: 'dao agent', scopes: ['read'], ttlSeconds: 600 });
    expect(issued).toMatchObject({ ok: true, value: { token: expect.stringMatching(/^tmc_/) } });
    const machine = ownerClient({ base: treasury.machineBase, fetch: (input, init) => fetch(input, { ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${issued.value.token}` } }) });
    expect(value(await machine.call('overview'))).toMatchObject({ agentId: treasury.agentId, area: 'treasury' });
    expect(await machine.call('held'), 'outside the read scope').toMatchObject({ ok: false, kind: 'forbidden' });
  } finally {
    await info.attach('stack-output', { body: output, contentType: 'text/plain' });
    if (child.exitCode === null) writeFileSync(join(directory, 'stop'), '');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 30_000))]);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  expect(await exited, 'the stack stops on its stop file').toBe(0);
});
