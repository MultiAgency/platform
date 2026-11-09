import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { appClient } from '../../src/contract/app-client.ts';
import { consentMessage, setupMessage } from '../../src/contract/app-consent.ts';
import { environment } from '../../test/e2e/environment.mjs';
import { OWNER, PUBLIC_KEY, USDC, sign } from '../../test/e2e/provider.mjs';
import { appCredential } from '../../test/e2e/stack-controls.mjs';
import { LOOKALIKE, PAYEE, SAFE } from './attacks.mjs';

// The platform as an app server meets it: the simulated stack (provider, chain, signatures and settlement simulated),
// an operator-issued service credential, and for each run a fresh hosted payout agent of its own Organization, set up
// as `test/e2e/app-access.spec.mjs` does it: the owner's consent, a grant, the payee agreed by a signed policy update,
// and simulated funding. The lookalike and the "safe" account exist on chain but are never agreed payees.

const localFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), rejectUnauthorized: false }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  }); req.on('error', reject); req.end(options.body);
});
const value = result => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; };
const later = days => new Date(Date.now() + days * 86_400_000).toISOString();
async function until(read, done, what, timeout = 30_000) {
  for (const deadline = Date.now() + timeout; ; await delay(200)) {
    const current = await read();
    if (done(current)) return current;
    if (Date.now() > deadline) throw new Error(`${what} timed out: ${JSON.stringify(current)}`);
  }
}

export async function crashStack(directory) {
  const stack = await environment(directory, { headless: true, accounts: [PAYEE, LOOKALIKE, SAFE] });
  const host = new URL(stack.dashboard).host;
  const app = appClient({ base: stack.dashboard, credential: await appCredential(stack, 'local'), fetch: localFetch });
  const ownerSigned = async message => {
    const nonce = randomBytes(32).toString('base64'), signed = await sign(OWNER, { message, recipient: host, nonce });
    return { message, nonce, publicKey: signed.publicKey, signature: signed.signature };
  };
  const ownerStep = async (agent, action) => {
    const prepared = value(await agent.call('owner/prepare', { action, signer: 'wallet' }));
    const signed = await sign(OWNER, prepared.intent.payload);
    value(await agent.call('owner/submit', { correlationId: prepared.correlationId, signedData: { ...prepared.intent, public_key: signed.publicKey, signature: signed.signature } }));
    // An approval's own status follows the payment it releases; the caller follows that payment instead.
    if (action.type !== 'approval_vote')
      await until(async () => value(await agent.call('owner/status', { correlationId: prepared.correlationId })).status, s => s === 'SUCCESS' || s === 'FAILED', `owner step ${action.type}`);
    return prepared;
  };

  /** A fresh payout agent for one run, in its own Organization: nothing a previous run left can block or confuse it. */
  async function payoutAgent(organization) {
    const { agent: name } = value(await app.setup(await ownerSigned(setupMessage({ host, deployment: 'local', organization, owner: OWNER, area: 'payables', expiresAt: later(1 / 48) }))));
    await until(async () => (await app.identity(name)).value?.created, created => created === false, 'hosted setup');
    const agent = app.agent(organization, name);
    await ownerStep(agent, { type: 'agent_create', owner: { type: 'near', account_id: OWNER, public_key: PUBLIC_KEY }, role: 'payout' });
    const agentId = value(await app.identity(name)).agentId;
    value(await app.consents.submit(await ownerSigned(consentMessage({ host, deployment: 'local', organization, owner: OWNER, agent: name, agentId,
      scopes: ['owner', 'payout', 'read'], expiresAt: later(90) }))));
    await ownerStep(agent, { type: 'grant_issue', label: 'invoices' });
    const reviewed = async () => { const o = value(await agent.call('overview')); return { revision: o.policy.revision, digest: o.digest }; };
    await ownerStep(agent, { type: 'policy_update', expectedPolicy: await reviewed(), changes: { destinations: [{ address: PAYEE, confidential: true }] } });
    stack.simulated.fund(agentId, 1_000_000_000n);
    return { agent, agentId, reviewed };
  }

  /** The owner's vote on a held payout, as the app relays it, then the provider settles it (simulated). */
  async function vote(agent, correlationId, verdict) {
    const held = await until(async () => value(await agent.call('held')), list => list.some(h => h.correlationId === correlationId), 'held payout');
    const { approvalId } = held.find(h => h.correlationId === correlationId);
    await ownerStep(agent, { type: 'approval_vote', approvalId, verdict, correlationId });
    const payment = () => stack.simulated.transfers.find(t => t.correlation === correlationId);
    await until(() => payment().status, s => s !== 'PENDING_APPROVAL', 'owner vote');
    if (verdict === 'approve') stack.simulated.settle(correlationId);
  }
  /** Until the platform has recorded the payout's final state: the payment landed, and the platform knows it. */
  const recorded = (agent, requestId) => until(async () => value(await agent.call('payouts/status', { requestId })).state,
    s => s === 'succeeded' || s === 'failed', 'recorded payout');

  /**
   * What a run left behind on its agent: unresolved operations (they block every later payout of that agent) and held
   * payouts. An agent with neither starts the next run as a fresh one would; the scenario's invoice id is new each run.
   */
  async function leftover(payout) {
    const [unresolved, held] = await Promise.all([payout.agent.call('unresolved'), payout.agent.call('held')]);
    return { unresolved: value(unresolved).length, held: value(held).length };
  }

  return {
    stack, payoutAgent, vote, recorded, leftover,
    transfersOf: agentId => stack.simulated.transfers.filter(t => t.agent === agentId).map(({ body, status, correlation }) => ({ body: { recipient: body.recipient, amount: body.amount }, status, correlation })),
    asset: USDC,
    close: () => stack.close(),
  };
}
