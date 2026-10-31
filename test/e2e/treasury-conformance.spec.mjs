import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { environment } from './environment.mjs';
import { browserContext, connectWallet } from './wallet.mjs';
import { PAYEE, OWNER, USDC, sign } from './provider.mjs';
import { clientConformance } from './conformance.mjs';
import { stackControls } from './stack-controls.mjs';

// M4 runtime conformance for Treasury's listed procedures (see `clientConformance`). Error kinds are forced where
// the procedure can return them.
const LISTED = ['activity', 'autopilot/enable', 'autopilot/evidence', 'autopilot/get', 'autopilot/log', 'autopilot/stop', 'autopilot/tick', 'deposit', 'executePlan',
  'held', 'inbox/list', 'instance', 'ledgerCsv', 'overview', 'owner/actions', 'owner/pending', 'owner/prepare', 'owner/status', 'owner/submit', 'policyHistory',
  'rebalance', 'reconcileBooks', 'recover', 'setup', 'steward/propose', 'strategy/get', 'strategy/save', 'sweep', 'treasury/fund', 'treasury/get', 'treasury/link',
  'treasury/setConfidential', 'treasury/unlink', 'unresolved', 'externalPlan'];

test('Treasury: every listed procedure through ownerClient equals its raw answer, with each reachable error kind', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const stack = await environment(info.outputPath('environment'), { workspace: true });
  const owner = await browserContext(browser, stack, PAYEE);
  try {
    const page = await owner.context.newPage();
    await page.goto(`${stack.dashboard}/a/portfolio/`);
    await connectWallet(page, PAYEE);
    const { client, check, outage, accepted, report } = clientConformance(page, '/a/portfolio', LISTED);

    // The strategy, saved by the owner through strategy/save (the stack's setTargets control).
    await stackControls(stack, { owner: PAYEE }).setTargets({ targetBps: { [USDC]: 7500, 'nep141:wrap.near': 2500, 'nep141:eth.omft.near': 0 },
      minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 0 } });

    // Reads.
    for (const procedure of ['instance', 'setup', 'overview', 'policyHistory', 'activity', 'unresolved', 'held', 'inbox/list', 'autopilot/get', 'strategy/get', 'treasury/get', 'ledgerCsv', 'reconcileBooks', 'owner/pending', 'owner/actions'])
      await check(procedure, undefined, 'ok');
    await check('autopilot/evidence', {}, 'ok');

    // Strategy save, owner-signed strategy grant, enable/stop, and a tick that records a run log.
    const current = (await client.call('strategy/get')).value;
    await check('strategy/save', { strategy: { ...current.strategy, minLegUsd: 3 }, expectedDigest: current.digest }, 'ok');
    const saved = (await client.call('strategy/get')).value;
    const prepared = await check('owner/prepare', { action: { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: saved.digest }, signer: 'wallet' }, 'ok');
    const signed = await sign(PAYEE, prepared.value.intent.payload);
    await check('owner/submit', { correlationId: prepared.value.correlationId, signedData: { ...prepared.value.intent, public_key: signed.publicKey, signature: signed.signature } }, 'ok');
    await expect.poll(async () => (await check('owner/status', { correlationId: prepared.value.correlationId })).value?.status).toBe('SUCCESS');
    await check('autopilot/enable', { expectedDigest: saved.digest }, 'ok');
    await check('autopilot/stop', undefined, 'ok');
    await check('autopilot/tick', undefined, 'ok');
    const runs = (await client.call('autopilot/evidence', {})).value;
    await check('autopilot/log', runs.length ? { tickId: runs.at(-1).id ?? runs.at(-1).tickId } : {}, undefined);

    // Treasury link, confidentiality, funding, unlink (chain fixture: owner.near exists).
    await check('treasury/link', { accountId: OWNER }, 'ok');
    await check('treasury/get', undefined, 'ok');
    await check('treasury/setConfidential', { confidential: true }, 'ok');
    await check('treasury/fund', { asset: 'USDC', amount: '1000000' }, 'ok');
    await check('treasury/unlink', undefined, 'ok');
    await check('deposit', undefined, 'ok');

    // Plans and streams.
    await check('rebalance', undefined, 'ok');
    const plan = await check('externalPlan', { swaps: [{ from: USDC, to: 'nep141:wrap.near', amount: '2000000' }] }, 'ok');
    await check('executePlan', { planId: plan.value.id }, 'ok');
    await check('sweep', { execute: false }, 'ok');
    await check('sweep', { execute: true }, 'ok');
    await check('recover', undefined, 'ok');
    await check('steward/propose', {}, undefined); // attested inference is not available offline: error path only

    // refused: invalid input never reaches a handler.
    for (const [procedure, input] of [['executePlan', { planId: 'not-a-plan' }], ['sweep', { execute: 'yes' }], ['externalPlan', { swaps: [] }], ['strategy/save', { strategy: {}, expectedDigest: 'x' }],
      ['autopilot/enable', { expectedDigest: 'x' }], ['autopilot/evidence', { since: 'yesterday' }], ['autopilot/log', { tickId: '' }], ['owner/prepare', { action: { type: 'nope' }, signer: 'wallet' }],
      ['owner/submit', { correlationId: '', signedData: {} }], ['owner/status', { correlationId: 5 }], ['treasury/link', { accountId: 'x' }], ['treasury/setConfidential', { confidential: 'yes' }],
      ['treasury/fund', { asset: 'DOGE', amount: '1' }], ['steward/propose', { instruction: 'x'.repeat(3000) }]])
      await check(procedure, input, 'refused');

    // Refused by the procedure's own guard: well-formed inputs the handler rejects before sending.
    const signedElsewhere = { ...prepared.value.intent, public_key: signed.publicKey, signature: signed.signature };
    for (const [procedure, input, kind] of [['strategy/save', { strategy: saved.strategy, expectedDigest: current.digest }, 'refused'],
      ['autopilot/enable', { expectedDigest: current.digest }, 'refused'], ['autopilot/log', { tickId: randomUUID() }, 'refused'],
      ['owner/submit', { correlationId: randomUUID(), signedData: signedElsewhere }, 'refused'],
      ['executePlan', { planId: randomUUID() }, 'refused'], ['treasury/link', { accountId: 'nobody.near' }, 'refused'],
      ['owner/prepare', { action: { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: current.digest }, signer: 'wallet' }, 'refused']])
      await check(procedure, input, kind);

    // busy: another holder has the money lock.
    const release = await lockfile.lock(join(stack.directory, 'portfolio/.ops', `${stack.portfolio.id}.jsonl`), { realpath: false, stale: 10_000, retries: 0 });
    try {
      const busyPlan = (await client.call('externalPlan', { swaps: [{ from: USDC, to: 'nep141:wrap.near', amount: '1000000' }] })).value;
      await check('executePlan', { planId: busyPlan.id }, 'busy');
      await check('sweep', { execute: true }, 'busy');
      await check('recover', undefined, 'busy');
    } finally { await release(); }

    // unresolved: a swap whose response was lost blocks the next execution.
    const lostPlan = (await client.call('externalPlan', { swaps: [{ from: USDC, to: 'nep141:wrap.near', amount: '1000000' }] })).value;
    stack.portfolio.dropSwapResponse(1);
    await check('executePlan', { planId: lostPlan.id }, 'unknown');
    const nextPlan = (await client.call('externalPlan', { swaps: [{ from: USDC, to: 'nep141:wrap.near', amount: '1000000' }] })).value;
    await check('executePlan', { planId: nextPlan.id }, 'unresolved');
    await check('sweep', { execute: true }, 'unresolved');
    await check('recover', undefined, 'ok');

    // provider: the provider is unavailable. Inputs that change with state are built fresh before the outage.
    const fresh = (await client.call('strategy/get')).value;
    const outagePlan = (await client.call('externalPlan', { swaps: [{ from: USDC, to: 'nep141:wrap.near', amount: '1000000' }] })).value;
    await outage(stack.portfolio, LISTED, {
      inputs: { 'strategy/save': { strategy: { ...fresh.strategy, minLegUsd: 4 }, expectedDigest: fresh.digest }, executePlan: { planId: outagePlan.id } },
      excluded: { 'steward/propose': 'attested inference is not available offline' },
    });

    report(info.outputPath('coverage.json'));
  } finally {
    await owner.context.close(); await stack.close();
  }
});
