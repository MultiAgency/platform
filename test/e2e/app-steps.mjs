import { expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stackFetch } from './stack-controls.mjs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appClient } from '../../src/contract/app-client.ts';
import { consentMessage, setupMessage } from '../../src/contract/app-consent.ts';
import { OWNER, PUBLIC_KEY, sign, signDelegate } from './provider.mjs';

/**
 * An app deployment's server on the local stack, as the E2E specs drive it: an operator-issued credential, the SDK's
 * appClient, the owner's simulated wallet, and owner steps (readable ones relayed, NEP-366 ones on the confirm page).
 */
export const later = days => new Date(Date.now() + days * 86_400_000).toISOString();
export const value = result => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; };

/** The operator issues a deployment credential; the app's client, the owner's simulated wallet and an owner step. */
export async function connect(stack) {
  const host = new URL(stack.dashboard).host, gateway = join(stack.directory, 'gateway');
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '../../src/app-credential.ts'), 'issue', 'local', host],
    { cwd: gateway, env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS } });
  const token = stdout.trim().split('\n').at(-1);
  expect(token).toMatch(/^tap_/);
  const localFetch = stackFetch(stack);
  const app = appClient({ base: stack.dashboard, credential: token, fetch: localFetch });
  const ownerSigned = async message => {
    const nonce = value(await app.consents.nonce()).nonce, signed = await sign(OWNER, { message, recipient: host, nonce });
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
  /**
   * A NEP-366 owner step: the app gets only a confirm link; the owner's wallet signs the link's text, then the delegate
   * it releases, through the confirm page's own calls (the browser path is shown once, for a policy edit).
   */
  const confirmStep = async (agent, action) => {
    const prepared = value(await agent.call('owner/prepare', { action, signer: 'wallet' }));
    expect(prepared.intent, 'the app never holds the delegate bytes').toBeUndefined();
    const api = prepared.confirm.url.replace('/confirm/', '/confirm/v1/');
    const view = await (await localFetch(api)).json();
    expect(view).toMatchObject({ type: action.type, state: 'open' });
    const { signature } = await sign(OWNER, view.opening);
    const opened = await localFetch(`${api}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) });
    expect(opened.status).toBe(200);
    const { intent } = await opened.json();
    expect(intent.standard).toBe('nep366');
    const submitted = await localFetch(api, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedData: { ...intent, signed_delegate: signDelegate(OWNER, intent.payload) } }) });
    expect(submitted.status).toBe(200);
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
    await ownerStep(app.agent(organization, name), { type: 'agent_create', owner: { type: 'near', account_id: OWNER, public_key: PUBLIC_KEY }, role: area === 'payables' ? 'payout' : area === 'market' ? 'market' : 'treasury' });
    return name;
  };
  return { host, gateway, app, localFetch, ownerSigned, ownerStep, confirmStep, consent, hostedAgent };
}
