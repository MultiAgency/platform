import { test, expect } from '@playwright/test';
import { environment } from './environment.mjs';
import { connect, value, later } from './app-steps.mjs';
import { setupMessage } from '../../src/contract/app-consent.ts';
import { OWNER } from './provider.mjs';

test('a wallet owner archives and explicitly releases a hosted agent, then restores its retained identity with new consent', async ({}, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { headless: true, secondAccount: true, appSetup: ['payables'] });
  try {
    const { app, host, hostedAgent, ownerStep, consent, ownerSigned } = await connect(stack);
    const name = await hostedAgent('release_1', 'payables');
    await consent('release_1', name, ['owner', 'read']);
    const agent = app.agent('release_1', name), id = value(await app.identity(name)).agentId;
    const oldConsents = value(await app.consents.list('release_1')).consents;
    const oldSetup = await ownerSigned(setupMessage({ host, deployment: 'local', organization: 'release_1', owner: OWNER, area: 'payables', expiresAt: later(1 / 48) }));
    expect(value(await app.release('release_1', name))).toMatchObject({ state: 'refused', reason: 'not_archived' });
    await ownerStep(agent, { type: 'agent_freeze' });
    await ownerStep(agent, { type: 'agent_archive' });
    const released = value(await app.release('release_1', name));
    expect(released).toMatchObject({ state: 'released', agent: name, agentId: id });
    expect(value(await app.release('release_1', name))).toEqual(released);
    expect(await app.identity(name)).toMatchObject({ ok: false, kind: 'refused', code: 'agent_released', status: 410 });
    expect(await agent.call('overview')).toMatchObject({ ok: false, code: 'agent_released' });
    expect(value(await app.reservations({ organization: 'release_1' })).agents).toContainEqual(expect.objectContaining({ agent: name, released: true }));
    const ended = value(await app.consents.list('release_1')).consents;
    expect(ended.every(c => c.revoked)).toBe(true);
    expect(ended.map(c => c.id).sort()).toEqual(oldConsents.map(c => c.id).sort());
    expect(await app.setup(oldSetup)).toMatchObject({ ok: false, code: 'owner_stopped' });
    const restored = value(await app.setup(await ownerSigned(setupMessage({ host, deployment: 'local', organization: 'release_1', owner: OWNER, area: 'payables', expiresAt: later(1 / 48) }))));
    expect(restored.agent).toBe(name);
    await expect.poll(async () => (await app.identity(name)).value?.agentId, { timeout: 30_000 }).toBe(id);
    expect(await agent.call('overview')).toMatchObject({ ok: false, kind: 'forbidden' });
    await consent('release_1', name, ['owner', 'read']);
    await ownerStep(agent, { type: 'agent_unfreeze' });
    await ownerStep(agent, { type: 'agent_restore' });
    expect(value(await app.identity(name)).agentId).toBe(id);
    expect(value(await app.consents.list('release_1')).consents.filter(c => oldConsents.some(o => o.id === c.id)).every(c => c.revoked)).toBe(true);
  } finally { await stack.close(); }
});
