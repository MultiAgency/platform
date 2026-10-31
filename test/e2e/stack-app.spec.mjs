import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** A `fetch` that trusts only the running stack's own certificate. Answers are buffered whole, streams included. */
const stackFetch = directory => {
  const ca = readFileSync(join(directory, 'environment', 'localhost.crt'));
  return (url, options = {}) => new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), ca }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }); req.on('error', reject); req.end(options.body);
  });
};
/** One control file, written whole, and its answer. */
const controlFiles = directory => {
  let sequence = 0;
  return async (command, input = {}) => {
    const path = join(directory, 'controls', `c${++sequence}.json`), answer = path.replace(/\.json$/, '.result.json');
    writeFileSync(`${path}.tmp`, JSON.stringify({ command, ...input })); renameSync(`${path}.tmp`, path);
    await expect.poll(() => existsSync(answer), { timeout: 30_000 }).toBe(true);
    return JSON.parse(readFileSync(answer, 'utf8'));
  };
};

/** Runs `stack.mjs` with `args` until `use` returns, then stops it through its stop file and expects a clean exit. */
async function withStack(info, args, use) {
  const artifacts = info.outputPath('stack-run'), directory = join(artifacts, 'stack');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'stack.mjs'), ...args],
    { env: { ...process.env, PROTO_E2E_ARTIFACTS: artifacts }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  try {
    await expect.poll(() => child.exitCode !== null || output.includes('Isolated stack ready'), { timeout: 120_000 }).toBe(true);
    expect(child.exitCode, output.slice(-2_000)).toBeNull();
    await use(directory, () => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')));
  } finally {
    await info.attach('stack-output', { body: output, contentType: 'text/plain' });
    if (child.exitCode === null) writeFileSync(join(directory, 'stop'), '');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 30_000))]);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  expect(await exited, 'the stack stops on its stop file').toBe(0);
}

test('a separate app server runs a held payout and a Treasury machine read on the running stack', async ({}, info) => {
  test.setTimeout(240_000);
  await withStack(info, ['--no-browser', '--treasury', '--app', 'dao-local'], async (directory, state) => {
    const { dashboard, app: appState, treasury } = state(), host = new URL(dashboard).host;
    expect(appState).toMatchObject({ deployment: 'dao-local', base: dashboard });
    expect(treasury.owner, 'one owner for both agents').toBe(OWNER);
    const credential = readFileSync(appState.credentialFile, 'utf8');
    expect(credential).toMatch(/^tap_/);
    expect(readFileSync(join(directory, 'state.json'), 'utf8'), 'the token stays out of state.json').not.toContain(credential);

    const fetch = stackFetch(directory), control = controlFiles(directory);
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
  });
});

// The Treasury agent's own controls, as the treasury app drives them: targets saved through the owner's strategy/save,
// a public balance to sweep, swaps between every listed pair, an outage and a lost swap reply on `portfolio` only.
test('the stack controls the Treasury agent: targets, a public balance, every pair, an outage and a lost swap reply', async ({}, info) => {
  test.setTimeout(240_000);
  await withStack(info, ['--no-browser', '--treasury'], async (directory, state) => {
    const { treasury } = state(), fetch = stackFetch(directory), control = controlFiles(directory);
    const [WNEAR, ETH] = ['nep141:wrap.near', 'nep141:eth.omft.near'];
    const targetBps = { [USDC]: 5000, [WNEAR]: 2000, [ETH]: 3000 };
    const saved = await control('setTargets', { targetBps });
    expect(saved, 'saved through strategy/save').toMatchObject({ ok: true, value: { strategy: { targetBps }, digest: expect.stringMatching(/^sha256:/) } });
    expect(await control('setTargets', {}), 'targets are required').toMatchObject({ ok: false });

    const issued = value(await control('machineCredential', { label: 'treasury app', scopes: ['read', 'prepare', 'execute-plan', 'sweep'], ttlSeconds: 600 }));
    const machine = ownerClient({ base: treasury.machineBase, fetch: (input, init) => fetch(input, { ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${issued.token}` } }) });
    const run = async (path, input) => {
      const events = [], stream = machine.stream(path, input);
      for (let next = await stream.next(); ; next = await stream.next()) { if (next.done) return { events, failure: next.value }; events.push(next.value); }
    };
    expect(value(await machine.call('strategy/get')).digest, 'the agent runs the saved strategy').toBe(saved.value.digest);

    // A public balance: the sweep plans it, shields it once, and nothing is left exposed.
    expect(await control('fundPublic', { asset: 'nep141:not-listed', amount: '1' })).toMatchObject({ ok: false });
    expect(await control('fundPublic', { asset: WNEAR, amount: '5000000000000000000000000' })).toEqual({ ok: true });
    const exposed = await run('sweep', { execute: false });
    expect(exposed.events[0].exposed.map(h => [h.asset, h.public])).toEqual([[WNEAR, 5000000000000000000000000n]]);
    const swept = await run('sweep', { execute: true });
    expect(swept.failure).toBeUndefined();
    expect(swept.events.filter(e => e.type === 'shield')).toEqual([expect.objectContaining({ asset: WNEAR, status: 'SUCCESS' })]);
    expect((await run('sweep', { execute: false })).events[0].exposed, 'nothing left public').toEqual([]);

    // A rebalance toward the saved targets swaps USDC into both wNEAR and ETH, each quoted from the listed prices.
    const planned = await run('rebalance');
    const plan = planned.events.find(e => e.type === 'saved')?.plan;
    expect(plan?.actions.map(a => a.to).sort()).toEqual([ETH, WNEAR].sort());
    const executed = await run('executePlan', { planId: plan.id });
    expect(executed.failure).toBeUndefined();
    expect(executed.events.map(e => [e.action.to, e.status]).sort()).toEqual([[ETH, 'SUCCESS'], [WNEAR, 'SUCCESS']].sort());
    expect(value(await machine.call('externalPlan', { swaps: [{ from: ETH, to: WNEAR, amount: '1000000000000000' }] })).actions[0],
      'any listed pair is quoted').toMatchObject({ from: ETH, to: WNEAR, amountOut: '1000000000000000000000000' });

    // An outage on portfolio's provider only.
    expect(await control('setUnavailable', { agent: 'nobody', value: true })).toMatchObject({ ok: false });
    expect(await control('setUnavailable', { agent: 'portfolio', value: true })).toEqual({ ok: true });
    expect(await machine.call('overview'), 'the outage reaches portfolio').toMatchObject({ ok: false });
    expect(await control('setUnavailable', { agent: 'portfolio', value: false })).toEqual({ ok: true });
    expect(await machine.call('overview')).toMatchObject({ ok: true });

    // A lost swap reply: the swap was applied but its answer never came, so the outcome is unknown and blocks the next send.
    const lost = value(await machine.call('externalPlan', { swaps: [{ from: USDC, to: WNEAR, amount: '1000000' }] }));
    expect(await control('dropSwapResponse', { after: 1 })).toEqual({ ok: true });
    expect((await run('executePlan', { planId: lost.id })).failure).toMatchObject({ ok: false, kind: 'unknown' });
    const next = value(await machine.call('externalPlan', { swaps: [{ from: USDC, to: WNEAR, amount: '1000000' }] }));
    expect((await run('executePlan', { planId: next.id })).failure).toMatchObject({ ok: false, kind: 'unresolved' });
  });
});

// An app's own build signs in with near-connect's default connect(), which asks which wallet to use; the stack's
// sign-in answers with its local test wallet. Loaded from the same CDN module the invoice page uses.
const APP_PAGE = `<!doctype html><meta charset="utf-8"><title>App</title><p id="account">Signed out.</p><button>Connect wallet</button>
<script type="module">
import { NearConnector } from "https://cdn.jsdelivr.net/npm/@fastnear/near-connect@0.14.1/+esm";
const connector = new NearConnector({ network: "mainnet", features: { signMessage: true },
  manifest: "https://cdn.jsdelivr.net/gh/fastnear/near-connect@d277b41263a8ea0a6892236b22824d46c2c3c377/repository/manifest.json" });
document.querySelector("button").onclick = async () => {
  await connector.connect();
  const { wallet } = await connector.getConnectedWallet();
  const challenge = await (await fetch("/gw/challenge")).json();
  const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: Uint8Array.from(atob(challenge.nonce), c => c.charCodeAt(0)) });
  const session = await fetch("/gw/session", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }) });
  if (session.ok) location.reload();
};
const viewer = (await (await fetch("/gw/me")).json()).viewer?.account;
if (viewer) document.querySelector("#account").textContent = "Signed in as " + viewer + ".";
</script>`;

test("the stack signs the owner in on an app's own build that asks which wallet to use", async ({}, info) => {
  test.setTimeout(180_000);
  const frontend = info.outputPath('app-build');
  mkdirSync(frontend, { recursive: true }); writeFileSync(join(frontend, 'index.html'), APP_PAGE);
  await withStack(info, ['--treasury', '--frontend', frontend], async (_directory, state) => {
    const { wallets, ownerFrontend } = state();
    expect(ownerFrontend).toEqual({ dist: frontend });
    expect(wallets.owner).toMatchObject({ account: OWNER, signedIn: true, blockedRequests: 0 });
  });
});
