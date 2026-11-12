import { test, expect } from '@playwright/test';
import { environment } from './environment.mjs';
import { connect, value } from './app-steps.mjs';

// A market agent on the real stack (docs/market.md): an app sets up the Organization's own market agent, the owner
// creates it, consents with `market` and grants it, the app funds it and the owner registers its payment key; then the
// app hires listed agents through /apps/v1. Provider, chain, wallet signatures and the agent market are simulated
// (provider.mjs, market.mjs); the market's x402 behaviour follows its skill and the mainnet runs (2026-11-09).

test('an app hires a listed agent through a market agent: paid once on delivery, and an undelivered hire is not charged', async ({}, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { headless: true, secondAccount: true, appSetup: ['payables', 'market'], market: true });
  const steps = [];
  try {
    const { app, ownerStep, consent, hostedAgent } = await connect(stack);
    const name = await hostedAgent('org_1', 'market');
    const created = value(await app.identity(name)).agentId;
    await consent('org_1', name, ['owner', 'market', 'read']);
    const agent = app.agent('org_1', name);
    await ownerStep(agent, { type: 'grant_issue', label: 'market' });
    expect(value(await agent.call('deposit')).address, 'the app takes a deposit address to fund the agent').toBeTruthy();
    stack.simulated.fund(created, 10_000_000n);
    const account = value(await agent.call('market/account'));
    expect(account).toMatchObject({ registered: false, opened: false, usdc: '0' });
    expect(account.registration.actions[0].params).toMatchObject({ methodName: 'storage_deposit', args: { account_id: account.account } });
    stack.market.register(account.account);
    steps.push("setup: the Organization's own market agent, its market grant (owner signatures), funding (simulated), and the payment key's registration (the owner's transaction, simulated)");

    const brief = 'An article\nWrite 300 words on NEAR Intents.';
    const approved = value(await agent.call('market/quote', { handle: 'writer', brief }));
    expect(approved).toMatchObject({ handle: 'writer', amount: '500000', network: 'near:mainnet' });
    const hired = value(await agent.call('market/hire', { requestId: 'h-1', brief, approved }));
    expect(hired).toMatchObject({ requestId: 'h-1' });
    expect(stack.simulated.requests.filter(request => request.path === '/chain' &&
      request.body?.params?.method_name === 'ft_balance_of' && request.body.params.account_id?.startsWith('nep141:')),
    'token balance reads use the raw contract account ID').toHaveLength(0);
    await expect.poll(async () => value(await agent.call('market/status', { requestId: 'h-1' })).state, { timeout: 30_000 }).toBe('paid');
    expect(value(await agent.call('market/status', { requestId: 'h-1' })).deliverable).toBe('the article');
    expect(value(await agent.call('market/account'))).toMatchObject({ opened: true, usdc: '0' });
    expect(value(await agent.call('market/hire', { requestId: 'h-1', brief, approved })).state, 'asked again: the journal answers').toBe('paid');
    expect(stack.market.chain.accounts.get(account.account).transfers, 'paid once').toHaveLength(1);
    steps.push('hire of `writer`: the key opened and topped up by the price, the payment taken, paid on delivery as the chain shows, once');

    expect(await agent.call('market/hire', { requestId: 'h-2', brief, approved: { ...approved, amount: '400000' } }))
      .toMatchObject({ ok: false, kind: 'refused', code: 'quote_changed' });
    const refuserTerms = value(await agent.call('market/quote', { handle: 'refuser', brief }));
    expect(value(await agent.call('market/hire', { requestId: 'h-3', brief, approved: refuserTerms }))).toMatchObject({ taskState: 'TASK_STATE_REJECTED' });
    expect(value(await agent.call('market/status', { requestId: 'h-3' })).state, 'the payment could still be relayed').toBe('unknown');
    stack.market.advance(2_000);
    expect(value(await agent.call('market/status', { requestId: 'h-3' })).state).toBe('not_charged');
    steps.push('a changed quote refused with nothing sent; a rejected hire unknown while its payment could settle, then not charged');

    expect(await agent.call('payouts/request', { requestId: 'p-1', asset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      delivery: { chain: 'near' }, recipient: account.account, amount: '1', expectedPolicy: { revision: 1, digest: 'sha256:' + '0'.repeat(64) } }))
      .toMatchObject({ ok: false, kind: 'forbidden' });
    steps.push('market consent reaches no payout request');
  } finally {
    await info.attach('steps', { body: steps.join('\n'), contentType: 'text/plain' });
    await stack.close();
  }
});

test('a top-up with a mismatched final receipt cannot fund this or another hire', async ({}, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { headless: true, secondAccount: true, appSetup: ['payables', 'market'], market: true });
  try {
    const { app, ownerStep, consent, hostedAgent } = await connect(stack);
    const name = await hostedAgent('org_1', 'market');
    const created = value(await app.identity(name)).agentId;
    await consent('org_1', name, ['owner', 'market', 'read']);
    const agent = app.agent('org_1', name);
    await ownerStep(agent, { type: 'grant_issue', label: 'market' });
    stack.simulated.fund(created, 10_000_000n);
    const account = value(await agent.call('market/account'));
    stack.market.register(account.account);

    const brief = 'An article\nWrite 300 words on NEAR Intents.';
    const approved = value(await agent.call('market/quote', { handle: 'writer', brief }));
    // The provider reports SUCCESS and the key is credited in the simulator, but the final receipt names a
    // different account. A balance increase alone must never release this hire's funding reservation.
    stack.market.mismatchNextFundingReceipt();
    expect(value(await agent.call('market/hire', { requestId: 'h-bad-proof', brief, approved })).state).toBe('funding_review');
    expect(value(await agent.call('market/status', { requestId: 'h-bad-proof' })).state).toBe('funding_review');
    expect(value(await agent.call('market/hire', { requestId: 'h-bad-proof', brief, approved })).state).toBe('funding_review');
    expect(value(await agent.call('market/hire', { requestId: 'h-other', brief, approved })).state).toBe('funding');

    const withdrawals = stack.simulated.requests.filter(request => request.method === 'POST' && request.path.endsWith('/withdraw'));
    expect(withdrawals, 'only the opening top-up was submitted').toHaveLength(1);
    expect(withdrawals[0].body.asset).toBe('nep141:wrap.near');
    expect(stack.market.calls.filter(call => call.payment !== null), 'neither hire sent an x402 payment').toHaveLength(0);
    expect(stack.market.chain.accounts.get(account.account).transfers).toHaveLength(0);
  } finally {
    await stack.close();
  }
});
