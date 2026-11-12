import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { consentMessage, setupMessage } from '../../src/contract/app-consent.ts';
import { environment } from './environment.mjs';
import { connect, later, value } from './app-steps.mjs';
import { BUILDER, DAO, OWNER, PUBLIC_KEY, USDC, sign } from './provider.mjs';
import { browserContext } from './wallet.mjs';

// An app deployment's server reaching the platform on the real stack: an operator-issued service credential, owner
// consents and a hosted setup signed by the simulated wallet, then reads and owner actions through /apps/v1 with
// the SDK's appClient. Provider, chain, signatures and settlement are simulated; the provider signs edits to
// provider-enforced policy fields as NEP-366, per its docs (not observed).

test('an app server relays readable owner actions, sends NEP-366 ones to the platform confirm page, and sets up a hosted agent', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { headless: true, secondAccount: true, accounts: [BUILDER], onChainPolicyEdits: true });
  const steps = [];
  try {
    // The operator issues the deployment's service credential on the platform host.
    const { host, gateway, app, localFetch, ownerSigned, ownerStep, confirmStep } = await connect(stack);
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

    // 2. Platform-built: freeze and unfreeze, NEP-366 like the provider's, so each goes through the confirm page.
    const frozen = await confirmStep(payout, { type: 'agent_freeze' });
    expect(stack.simulated.payoutPolicy().policy.frozen).toBe(true);
    const unfrozen = await confirmStep(payout, { type: 'agent_unfreeze' });
    expect(stack.simulated.payoutPolicy().policy.frozen).toBe(false);
    steps.push('freeze and unfreeze (NEP-366), each signed by the owner through the confirm page');

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
    // Traced for a failure only: a full-suite run once stalled with the button visible and never clicked (2026-10-30).
    await wallet.context.tracing.start({ screenshots: true, snapshots: true });
    let signed = false;
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
      // The page may finish connecting the wallet on its own and replace the Connect button while the test reaches for
      // it (seen 2026-10-30: the click then waited for a button that no longer existed). Whichever comes first wins:
      // the page signing the owner in, or the test connecting, choosing the local wallet if near-connect asks.
      if (!(await sign.isVisible())) {
        const chooser = page.getByText('Local test wallet', { exact: true });
        const connecting = connect.click({ timeout: 15_000 })
          .then(() => Promise.race([chooser.waitFor({ timeout: 15_000 }).then(() => chooser.click({ timeout: 15_000 })), sign.waitFor({ timeout: 15_000 })]))
          .catch(() => {});
        await Promise.race([connecting, sign.waitFor({ timeout: 30_000 })]);
      }
      // Bounded: a stall fails here with Playwright's actionability log instead of at the test timeout.
      await sign.click({ timeout: 15_000 });
      await expect(page.getByText(/Submitted\. The app follows the outcome/)).toBeVisible();
      expect(wallet.signatures.filter(s => s.delegate)).toHaveLength(1);
      expect(wallet.signatures.filter(s => !s.delegate).map(s => s.message.split('\n')[0]), 'first the link\'s readable text').toEqual(['Open a MultiAgency confirm page.']);
      signed = true;
    } finally {
      await wallet.context.tracing.stop(signed ? undefined : { path: info.outputPath('confirm-trace.zip') });
      await wallet.context.close();
    }
    await expect.poll(async () => value(await payout.call('owner/status', { correlationId: held.correlationId })).status).toBe('SUCCESS');
    expect(stack.simulated.payoutPolicy()).toMatchObject({ revision: 4, policy: { owner_approval: false } });
    const logs = join(gateway, '.app-access');
    const log = readdirSync(logs).filter(name => /^access-\d{4}-\d{2}\.jsonl$/.test(name)).sort()
      .map(name => readFileSync(join(logs, name), 'utf8')).join('').trim().split('\n').map(line => JSON.parse(line));
    expect(log.filter(l => ['confirm', 'confirmed'].includes(l.event)).map(l => [l.event, l.correlationId]))
      .toEqual([frozen, unfrozen, held].flatMap(({ correlationId }) => [['confirm', correlationId], ['confirmed', correlationId]]));
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

    // 8. The owner revokes that grant through the app (NEP-413): the provider no longer lists it as live.
    const grantsOf = async () => (await (await fetch(`${stack.simulated.url}/v1/agents/${created.agentId}/grants`)).json()).data;
    const [issued] = await grantsOf();
    expect(issued).toMatchObject({ label: 'invoices', revoked_at: null });
    await ownerStep(hosted, { type: 'grant_revoke', grantId: issued.grant_id });
    expect((await grantsOf()).find(g => g.grant_id === issued.grant_id).revoked_at).not.toBeNull();
    steps.push('grant revoked by the owner through the app');

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
  const stack = await environment(info.outputPath('environment'), { headless: true, secondAccount: true, accounts: [BUILDER] });
  const steps = [];
  try {
    const { app, ownerStep, consent, hostedAgent } = await connect(stack);
    const name = await hostedAgent('org_1', 'payables');
    const created = value(await app.identity(name)).agentId;
    await consent('org_1', name, ['owner', 'payout', 'read']);
    const agent = app.agent('org_1', name);
    // A `payout` grant, the label an app's payout agent holds (platform#54: the simulator refused it).
    await ownerStep(agent, { type: 'grant_issue', label: 'payout' });
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
    expect(vote.payment).toEqual({ correlationId: first.correlationId, verdict: 'approve', terms: { recipient: BUILDER, asset: USDC, amount: '2000000' },
      repeats: { checked: true, payouts: [] } });
    expect(vote.intent.standard).toBe('nep413');
    const signed = await sign(OWNER, vote.intent.payload);
    value(await agent.call('owner/submit', { correlationId: vote.correlationId, signedData: { ...vote.intent, public_key: signed.publicKey, signature: signed.signature } }));
    stack.simulated.settle(first.correlationId);
    await expect.poll(async () => value(await agent.call('payouts/status', { requestId: 'wo-1' })).state).toBe('succeeded');
    expect(stack.simulated.transfers).toHaveLength(1);
    steps.push("the owner's vote, relayed by the app with the proven terms, released the held payout once");

    // The same payout again under a new requestId, once the first has settled (the crash test's "pay again"): it is held for
    // the owner like any payout, and its vote names the first beside its terms. The owner rejects it; nothing moves.
    const again = value(await ask('wo-again'));
    expect(again).toMatchObject({ requestId: 'wo-again', state: 'held' });
    const { approvalId: againApproval } = value(await agent.call('held')).find(h => h.correlationId === again.correlationId);
    const repeat = value(await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId: againApproval, verdict: 'approve', correlationId: again.correlationId }, signer: 'wallet' }));
    expect(repeat.payment.repeats).toEqual({ checked: true, payouts: [{ correlationId: first.correlationId, at: expect.any(String), status: 'SUCCESS' }] });
    expect(repeat.confirm.url, 'the confirm page shows it too').toMatch(/\/confirm\//);
    const refusal = value(await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId: againApproval, verdict: 'reject', correlationId: again.correlationId }, signer: 'wallet' }));
    const rejection = await sign(OWNER, refusal.intent.payload);
    value(await agent.call('owner/submit', { correlationId: refusal.correlationId, signedData: { ...refusal.intent, public_key: rejection.publicKey, signature: rejection.signature } }));
    await expect.poll(async () => value(await agent.call('payouts/status', { requestId: 'wo-again' })).state).toBe('failed');
    expect(value(await agent.call('payouts/status', { requestId: 'wo-again' })))
      .toMatchObject({ correlationId: again.correlationId, failureCode: 'rejected_by_owner', neverExecuted: true });
    steps.push('a second payout of the same terms after the first settled is held, its vote names the first, and the owner rejects it');

    // A withdrawal to chain near (P3b): the owner agrees a withdrawal payee through the app; each request is held for the
    // owner, whose approval, proven against the provider's hash, releases it once, and whose rejection ends one unpaid.
    await ownerStep(agent, { type: 'policy_update', expectedPolicy: await reviewed(), changes: { withdrawals: [{ address: BUILDER }] } });
    expect(stack.simulated.payoutPolicy(created).policy).toMatchObject({ actions: ['transfer', 'withdraw'] });
    const withdrawn = value(await agent.call('payouts/request', { requestId: 'wd-1', asset: USDC, delivery: { chain: 'near' }, recipient: BUILDER,
      amount: '500000', expectedPolicy: await reviewed() }));
    expect(withdrawn).toMatchObject({ requestId: 'wd-1', state: 'held' });
    const heldWithdrawal = stack.simulated.transfers.find(p => p.type === 'withdraw');
    expect(heldWithdrawal.body).toEqual({ asset: USDC, amount: '500000', chain: 'near', recipient: BUILDER, confidential: true });
    const pending = value(await agent.call('held')).find(h => h.correlationId === withdrawn.correlationId);
    const approve = value(await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId: pending.approvalId, verdict: 'approve', correlationId: withdrawn.correlationId }, signer: 'wallet' }));
    expect(approve.payment).toEqual({ correlationId: withdrawn.correlationId, verdict: 'approve', terms: { recipient: BUILDER, asset: USDC, amount: '500000', chain: 'near' },
      repeats: { checked: true, payouts: [] } });
    const approved = await sign(OWNER, approve.intent.payload);
    value(await agent.call('owner/submit', { correlationId: approve.correlationId, signedData: { ...approve.intent, public_key: approved.publicKey, signature: approved.signature } }));
    stack.simulated.settle(withdrawn.correlationId);
    await expect.poll(async () => value(await agent.call('payouts/status', { requestId: 'wd-1' })).state).toBe('succeeded');
    expect(stack.simulated.transfers.filter(p => p.type === 'withdraw'), 'the approved withdrawal was sent once').toHaveLength(1);
    // The approving vote's own status ends with the withdrawal it released, on the owner-intent watcher's next pass (10 s).
    await expect.poll(async () => value(await agent.call('owner/status', { correlationId: approve.correlationId })), { timeout: 30_000 })
      .toEqual({ stage: 'submitted', status: 'SUCCESS', failureCode: null, phase: 'settled' });
    steps.push("a withdrawal to chain near was held for the owner; the owner's vote, with the terms proven against the provider's hash, released it once");
    // A vote's status follows the payout it decides: a rejected one ends FAILED.
    const second = value(await agent.call('payouts/request', { requestId: 'wd-2', asset: USDC, delivery: { chain: 'near' }, recipient: BUILDER,
      amount: '400000', expectedPolicy: await reviewed() }));
    expect(second).toMatchObject({ requestId: 'wd-2', state: 'held' });
    const secondHeld = stack.simulated.transfers.find(p => p.correlation === second.correlationId);
    const { approvalId: secondApproval } = value(await agent.call('held')).find(h => h.correlationId === second.correlationId);
    const reject = value(await agent.call('owner/prepare', { action: { type: 'approval_vote', approvalId: secondApproval, verdict: 'reject', correlationId: second.correlationId }, signer: 'wallet' }));
    expect(reject.payment).toEqual({ correlationId: second.correlationId, verdict: 'reject', terms: null });
    const rejected = await sign(OWNER, reject.intent.payload);
    value(await agent.call('owner/submit', { correlationId: reject.correlationId, signedData: { ...reject.intent, public_key: rejected.publicKey, signature: rejected.signature } }));
    await expect.poll(async () => value(await agent.call('owner/status', { correlationId: reject.correlationId })).status).toBe('FAILED');
    await expect.poll(async () => value(await agent.call('payouts/status', { requestId: 'wd-2' })).state).toBe('failed');
    expect(secondHeld.failure).toBe('rejected_by_owner');
    expect(value(await agent.call('payouts/status', { requestId: 'wd-2' })))
      .toMatchObject({ correlationId: second.correlationId, failureCode: 'rejected_by_owner', neverExecuted: true });
    expect(value(await agent.call('paymentStatus', { correlationId: second.correlationId })))
      .toMatchObject({ status: 'FAILED', failureCode: 'rejected_by_owner', evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundedAmount: null } });
    // Fault the provider's details, then read through the real gateway and SDK. A rejection code or absent hashes alone
    // proves nothing; even a positive flag cannot overrule evidence of submission, delivery or refund.
    const requestsBeforeProofReads = stack.simulated.transfers.length;
    for (const details of [{}, { never_executed: 'true' },
      ...['tx_hash', 'destination_tx_hash', 'intent_hash', 'amount_out', 'refund_tx_hash', 'refunded_amount', 'settled_late']
        .map(key => ({ never_executed: true, [key]: key === 'settled_late' ? true : 'fixture-effect' }))]) {
      secondHeld.details = details;
      expect(value(await agent.call('payouts/status', { requestId: 'wd-2' })))
        .toMatchObject({ state: 'failed', correlationId: second.correlationId, failureCode: 'rejected_by_owner', neverExecuted: false });
    }
    secondHeld.details = { never_executed: true };
    expect(value(await agent.call('payouts/status', { requestId: 'wd-2' })).neverExecuted).toBe(true);
    expect(stack.simulated.transfers, 'proof reads send no replacement').toHaveLength(requestsBeforeProofReads);
    steps.push('a second held withdrawal was rejected by the owner and ended unpaid');

    // A lost reply: the provider accepted the transfer, and its answer never arrived.
    stack.simulated.dropTransferResponse();
    expect(value(await ask('wo-3', '1000000'))).toMatchObject({ requestId: 'wo-3', state: 'unknown' });
    const accepted = stack.simulated.transfers.length;
    expect(stack.simulated.transfers.filter(p => p.type !== 'withdraw')).toHaveLength(3);
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

test("an app sets up an Organization's own Treasury agent; its plans run only under the owner's grant for the saved strategy, and a warned quote is refused", async ({}, info) => {
  test.setTimeout(180_000);
  // The headless host with Treasury in `appSetup`, as on platform-staging.json.
  const stack = await environment(info.outputPath('environment'), { headless: true, secondAccount: true, appSetup: ['treasury', 'payables'] });
  const steps = [];
  try {
    const { app, ownerStep, consent, hostedAgent } = await connect(stack);
    const WNEAR = 'nep141:wrap.near';
    const name = await hostedAgent('org_1', 'treasury');
    const created = value(await app.identity(name)).agentId;
    expect(stack.simulated.payoutPolicy(created).policy.actions, 'created with the Treasury policy').toEqual(['swap']);
    await consent('org_1', name, ['owner', 'read', 'treasury', 'treasury-execute']);
    const agent = app.agent('org_1', name);
    stack.simulated.fund(created, 10_000_000n);
    steps.push("setup: the Organization's own Treasury agent, created by the owner (simulated signature), consented with treasury and treasury-execute, funded (simulated)");

    const swaps = () => stack.simulated.swaps.filter(s => s.agent === created);
    const plan = () => agent.call('externalPlan', { swaps: [{ from: USDC, to: WNEAR, amount: '1000000' }] });
    const run = async planId => { const stream = agent.stream('executePlan', { planId }), seen = [];
      for (let next = await stream.next(); ; next = await stream.next()) { if (next.done) return seen; seen.push(next.value); } };

    // The owner's grant for the saved strategy, signed through the app; then one plan executes once.
    const saved = value(await agent.call('strategy/get'));
    await ownerStep(agent, { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: saved.digest });
    expect(stack.simulated.created().length).toBe(1);
    expect((await run(value(await plan()).id)).map(e => [e.type, e.status])).toEqual([['action', 'SUCCESS']]);
    expect(swaps(), 'one swap, by the created agent').toHaveLength(1);
    expect(stack.simulated.treasuryBalances(created)[USDC]).toBe('9000000');
    steps.push("the owner's grant for the saved strategy (simulated signature); the app's plan swapped once on the created agent");

    // The provider's history lists the swap, so the agent's books carry it: its ledger row and its CSV line.
    const [swapped] = swaps();
    expect(value(await agent.call('ledger')).filter(r => r.type === 'swap')).toEqual([expect.objectContaining({ correlationId: swapped.correlation_id,
      status: 'SUCCESS', assetIn: USDC, assetOut: WNEAR, amountOut: swapped.amountOut })]);
    expect(value(await agent.call('ledgerCsv'))).toContain(swapped.correlation_id);
    steps.push("the swap read back from the provider's history into the ledger and its CSV");

    // A dry quote warned high_fee: the plan is refused before it is saved, and nothing is sent.
    stack.simulated.warnQuotes(['high_fee']);
    expect(await plan()).toMatchObject({ ok: false, kind: 'refused', error: expect.stringMatching(/dry run warned \(high_fee\)/) });
    stack.simulated.warnQuotes([]);
    expect(swaps()).toHaveLength(1);
    steps.push('a quote the provider warned (high_fee, simulated) refused the plan; nothing sent');

    // Autopilot turns on only for the strategy the owner's grant binds, and stops.
    expect(value(await agent.call('autopilot/enable', { expectedDigest: saved.digest })).on).toBe(true);
    expect(value(await agent.call('autopilot/stop')).on).toBe(false);

    // The frame's observations (0.5.1): the agent's wallet and the grant this executor holds, matched by its token.
    const account = value(await agent.call('account'));
    expect(account).toMatchObject({ executor: true, stagedGrant: null });
    expect(account.wallet, "the agent's wallet account").toBeTruthy();
    expect(account.grant?.label, 'the grant for the saved strategy, held by this executor').toMatch(/^treasury:[0-9a-f]{32}$/);
    expect(Array.isArray(value(await agent.call('reconcileBooks'))), 'each balance against its independent record').toBe(true);
    // A wallet owner's app links a treasury account, reads it back, and unlinks it.
    value(await agent.call('treasury/link', { accountId: OWNER }));
    expect(value(await agent.call('treasury/get'))?.accountId).toBe(OWNER);
    value(await agent.call('treasury/unlink'));
    expect(value(await agent.call('treasury/get'))).toBeNull();
    steps.push("account named the agent's wallet and its strategy grant; reconcileBooks read; a treasury account linked and unlinked");

    // The app saves another strategy: no plan of its runs, and autopilot can't turn on, until the owner signs for it.
    const next = value(await agent.call('strategy/save', { strategy: { ...saved.strategy, maxCostBps: saved.strategy.maxCostBps + 1 }, expectedDigest: saved.digest }));
    expect(await run(value(await plan()).id)).toEqual([{ type: 'rejected', problems: [expect.stringMatching(/grant doesn't bind the saved strategy/)] }]);
    expect(await agent.call('autopilot/enable', { expectedDigest: next.digest }), 'no grant binds the new strategy').toMatchObject({ ok: false });
    expect(swaps(), 'nothing sent under the unbound grant').toHaveLength(1);
    steps.push('autopilot on and off under the bound grant; after the app saved another strategy, its plan and autopilot were refused');
  } finally {
    await info.attach('steps', { body: JSON.stringify(steps, null, 2), contentType: 'application/json' });
    await stack.close();
  }
});

test("a DAO consents to an app by its own vote; its grant vote lets autopilot run; a vote approves its proposal; the DAO stops it all with no app", async ({}, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { daoPortfolio: true, headless: true });
  try {
    const { host, app, localFetch } = await connect(stack);
    /** A member files the DAO's proposal and it passes: the simulated MPC key signs the hash it names. */
    const passes = transaction => {
      const call = transaction.actions[0].params, kind = call.args.proposal.kind.FunctionCall.actions[0];
      stack.simulated.daoVote(JSON.parse(Buffer.from(kind.args, 'base64').toString()).request.payload_v2.Eddsa);
    };
    const identity = value(await app.identity('portfolio'));
    expect(identity).toMatchObject({ owner: DAO, signer: 'dao', created: true });

    const filed = value(await app.daoConsents.file(consentMessage({ host, deployment: 'local', organization: 'org_1', owner: DAO,
      agent: 'portfolio', agentId: identity.agentId, scopes: ['read', 'treasury'], expiresAt: later(90) })));
    expect(value(await app.daoConsents.state(filed.request.id)).state, 'nothing is stored before the vote').toBe('pending');
    // Members check what they vote on at the platform's own page, which the proposal links to.
    const check = `${stack.dashboard}/confirm/dao/${filed.request.hash}`;
    expect(filed.request.description).toContain(`https://${host}/confirm/dao/${filed.request.hash}`);
    const shown = await localFetch(check);
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain('Recomputed here from the text, nonce and host: it matches.');
    passes(filed.transactions.proposal);
    const consent = value(await app.daoConsents.state(filed.request.id));
    expect(consent).toMatchObject({ state: 'signed', consent: { signer: 'dao', owner: DAO, scopes: ['read', 'treasury'] } });
    const agent = app.agent('org_1', 'portfolio');

    // Whether the DAO is confidential is read from chain: set up for confidential intents, its key on Trezu's path (its
    // own name) is registered on intents.near. A read that fails gives no answer, never `false`.
    expect(value(await agent.call('treasury/get'))).toMatchObject({ accountId: DAO, confidential: false });
    stack.simulated.daoConfidentialSetup();
    expect(value(await agent.call('treasury/get'))).toMatchObject({ accountId: DAO, confidential: true, payees: [] });
    stack.simulated.failChainView('public_keys_of');
    expect(await agent.call('treasury/get'), 'a failed chain read fails the call').toMatchObject({ ok: false, kind: 'unavailable' });
    stack.simulated.failChainView(null);

    // The strategy-bound grant is a DAO vote: the platform prepares it, and the agent submits the DAO's signature itself.
    const strategy = value(await agent.call('strategy/get'));
    const grant = value(await agent.call('owner/prepare', { action: { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: strategy.digest }, signer: 'dao' }));
    expect(grant.intent, 'the app never gets an intent to sign').toBeUndefined();
    passes(grant.dao.proposal);
    await expect.poll(async () => value(await agent.call('owner/status', { correlationId: grant.correlationId })).status, { timeout: 45_000 }).toBe('SUCCESS');
    // The DAO's grant vote is what authorizes unattended swaps: autopilot turns on under it, and off.
    expect(value(await agent.call('autopilot/enable', { expectedDigest: strategy.digest })).on).toBe(true);
    expect(value(await agent.call('autopilot/stop')).on).toBe(false);
    // Run now under the DAO's consent: one pass, under the DAO-voted grant; the frame names that grant.
    expect(typeof value(await agent.call('autopilot/tick'))).toBe('string');
    expect(value(await agent.call('account')).grant?.label).toBe(`treasury:${strategy.grantSuffix}`);
    // The DAO's treasury link is the DAO itself: an app never changes it.
    expect(await agent.call('treasury/link', { accountId: OWNER }), 'refused under a DAO consent').toMatchObject({ ok: false, kind: 'forbidden' });

    const proposal = value(await agent.call('proposals/create', { requestId: 'dao-1', legs: [{ from: USDC, to: 'nep141:wrap.near', amount: '1000000' }], expiresAt: later(2) }));
    expect(await agent.call('proposals/approve', { id: proposal.id, signed: { message: 'x', nonce: 'x', publicKey: PUBLIC_KEY, signature: 'x' } }),
      'only a DAO vote approves').toMatchObject({ ok: false, kind: 'forbidden' });
    const vote = value(await app.daoVotes.file({ organization: 'org_1', agent: 'portfolio', proposal: proposal.id, verdict: 'approve' }));
    expect(vote.request.description).toContain(`Approve Treasury proposal ${proposal.id}`);
    expect(value(await app.daoVotes.state(vote.request.id)).state).toBe('pending');
    passes(vote.transactions.proposal);
    expect(value(await app.daoVotes.state(vote.request.id))).toMatchObject({ state: 'relayed', proposalState: 'approved' });

    const done = value(await agent.call('proposals/execute', { id: proposal.id }));
    expect(done).toMatchObject({ state: 'executed', operations: [expect.objectContaining({ method: 'swap', status: 'SUCCESS' })] });
    expect(value(await agent.call('proposals/execute', { id: proposal.id })).state, 'asked again, nothing is sent').toBe('executed');
    expect(stack.portfolio.swaps.length, 'one swap').toBe(1);

    // The DAO stops the agent by its own vote, with no app: every consent filed before the stop ends and autopilot turns off.
    expect(value(await agent.call('autopilot/enable', { expectedDigest: strategy.digest })).on).toBe(true);
    const stopPage = `${stack.dashboard}/confirm/dao/stop/${DAO}/portfolio`;
    const filedStop = await (await localFetch(stopPage)).text();
    const stopHash = filedStop.match(/Hash <code>([a-f0-9]{64})<\/code>/)[1];
    expect(value(await agent.call('overview')), 'nothing changes before the vote').toBeTruthy();
    stack.simulated.daoVote(stopHash);
    expect(await (await localFetch(stopPage)).text()).toContain("This DAO's agent was stopped");
    expect(await agent.call('overview'), 'the app no longer reaches it').toMatchObject({ ok: false, kind: 'forbidden' });
    expect(stack.portfolioState().settings, 'autopilot is off').toMatch(/^AUTOPILOT=$/m);
  } finally { await stack.close(); }
});

test("a DAO sets up its own hosted Treasury agent by vote, creates it by a second vote, then consents to the app by a third", async ({}, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { daoPortfolio: true, headless: true, appSetup: ['treasury', 'payables'] });
  try {
    const { host, app } = await connect(stack);
    const passes = transaction => {
      const kind = transaction.actions[0].params.args.proposal.kind.FunctionCall.actions[0];
      stack.simulated.daoVote(JSON.parse(Buffer.from(kind.args, 'base64').toString()).request.payload_v2.Eddsa);
    };
    const filed = value(await app.daoSetups.file(setupMessage({ host, deployment: 'local', organization: 'org_2', owner: DAO, area: 'treasury', expiresAt: later(3) })));
    expect(value(await app.daoSetups.state(filed.request.id)).state, 'nothing is reserved before the vote').toBe('pending');
    passes(filed.transactions.proposal);
    const reserved = value(await app.daoSetups.state(filed.request.id));
    expect(reserved).toMatchObject({ state: 'reserved', consent: { signer: 'dao', agentId: 'unborn', scopes: ['owner'] } });
    await expect.poll(async () => (await app.identity(reserved.agent)).value?.created, { timeout: 30_000 }).toBe(false);

    const agent = app.agent('org_2', reserved.agent);
    const create = value(await agent.call('owner/prepare', { action: { type: 'agent_create', role: 'treasury' }, signer: 'dao' }));
    expect(create.intent, 'the app never gets an intent to sign').toBeUndefined();
    passes(create.dao.proposal);
    await expect.poll(async () => value(await agent.call('owner/status', { correlationId: create.correlationId })).status, { timeout: 45_000 }).toBe('SUCCESS');
    const identity = value(await app.identity(reserved.agent));
    expect(identity).toMatchObject({ owner: DAO, signer: 'dao', created: true });

    const consent = value(await app.daoConsents.file(consentMessage({ host, deployment: 'local', organization: 'org_2', owner: DAO,
      agent: reserved.agent, agentId: identity.agentId, scopes: ['read', 'treasury'], expiresAt: later(90) })));
    passes(consent.transactions.proposal);
    expect(value(await app.daoConsents.state(consent.request.id))).toMatchObject({ state: 'signed', consent: { agentId: identity.agentId } });
    expect((await agent.call('overview')).ok, 'the DAO consent reads the agent it created').toBe(true);
  } finally { await stack.close(); }
});
