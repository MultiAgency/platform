import { test, expect } from '@playwright/test';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { environment, strategyFixture } from './environment.mjs';
import { browserContext, connectWallet, machineAccess } from './wallet.mjs';
import { PAYEE } from './provider.mjs';

const localFetch = (url, options) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, { method: options.method, headers: Object.fromEntries(new Headers(options.headers)), rejectUnauthorized: false }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  }); req.on('error', reject); req.end(options.body);
});
test('machine access issues once, machine calls stay guarded, and outage revocation survives reload', async ({ browser }, info) => {
  const stack = await environment(info.outputPath('environment'), { workspace: true, independentFrontend: true });
  const wallet = await browserContext(browser, stack, PAYEE);
  const page = await wallet.context.newPage();
  const label = 'A'.repeat(80);
  await wallet.context.tracing.start({ screenshots: true, snapshots: true });
  try {
    expect(await (await localFetch(`${stack.dashboard}/`, { method: 'GET' })).text()).toContain('Independent Treasury frontend');
    // The owner signs in on the product's own page and manages access through the gateway's routes.
    await page.goto(`${stack.dashboard}/`);
    await connectWallet(page, PAYEE);
    const access = machineAccess(page, 'portfolio');
    const scopes = ['read', 'prepare', 'execute-plan'];
    const issued = await access('POST', '', { label, scopes });
    expect(issued.status).toBe(201);
    expect(issued.body.credential).toMatchObject({ label, scopes, agent: 'portfolio', agentId: stack.portfolio.id, revoked: false });
    const token = issued.body.token;
    const client = createORPCClient(new RPCLink({ origin: stack.dashboard, url: '/machine/v1/a/portfolio/rpc', headers: { authorization: `Bearer ${token}` }, fetch: localFetch }));
    expect((await client.instance()).agentId).toBe(stack.portfolio.id);
    // Outside the credential's scopes: the gateway's plain route refusal (403, surfaced as oRPC's malformed response).
    await expect(client.sweep({})).rejects.toMatchObject({ response: { status: 403 } });
    await expect(client.autopilot.tick()).rejects.toMatchObject({ response: { status: 403 } });
    // Offline owner-strategy fixture: one supported swap, autopilot ceiling remains zero; not yet authorized.
    const strategy = { targetBps: {
      'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 7500,
      'nep141:wrap.near': 2500, 'nep141:eth.omft.near': 0 }, minLegUsd: 2, maxCostBps: 250,
      autopilot: { everyMin: 60, maxUsd: 0 } };
    await strategyFixture(stack, strategy, { authorized: false });
    const swaps = [{ from: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      to: 'nep141:wrap.near', amount: '3000000' }];
    swaps.push({ ...swaps[0], amount: '2000000' });
    const skill = process.env.PROTO_E2E_TREASURY_SKILL;
    const swapsFile = join(stack.directory, 'chosen-swaps.json'); writeFileSync(swapsFile, JSON.stringify({ swaps }));
    const helper = async (...args) => {
      const result = await promisify(execFile)(process.execPath, [join(skill, 'scripts/treasury.mjs'), ...args], {
        env: { ...offlineEnvironment(), FORCE_COLOR: undefined, NODE_OPTIONS: process.env.NODE_OPTIONS,
          NODE_EXTRA_CA_CERTS: join(stack.directory, 'localhost.crt'),
          TREASURY_URL: stack.dashboard, TREASURY_NAME: 'portfolio', TREASURY_MACHINE_TOKEN: token }, timeout: 30_000 });
      expect(result.stderr).toBe(''); return result.stdout.trim().split('\n').map(line => JSON.parse(line));
    };
    // A machine credential's plan runs only under a grant binding the saved strategy.
    const unbound = []; for await (const event of await client.executePlan({ planId: (await client.externalPlan({ swaps })).id })) unbound.push(event);
    expect(unbound).toEqual([{ type: 'rejected', problems: [expect.stringMatching(/grant doesn't bind the saved strategy/)] }]);
    expect(stack.portfolio.swaps).toHaveLength(0);
    await strategyFixture(stack, strategy);
    const plan = skill ? (await helper('prepare', swapsFile))[0] : await client.externalPlan({ swaps });
    expect(plan.source).toBe('external');
    expect(plan.actions.map(({ from, to, amount }) => ({ from, to, amount }))).toEqual(swaps);
    expect(plan?.id).toBeTruthy();
    expect(stack.portfolio.swaps).toHaveLength(0);
    const events = skill ? await helper('execute', plan.id) : [];
    if (!skill) for await (const event of await client.executePlan({ planId: plan.id })) events.push(event);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => ['action', 'rejected'].includes(event.type))).toBe(true);
    const count = stack.portfolio.swaps.length; expect(count).toBe(2);
    expect(stack.portfolio.swaps.map(swap => swap.body.amount)).toEqual(swaps.map(swap => swap.amount));
    const again = []; for await (const event of await client.executePlan({ planId: plan.id })) again.push(event);
    expect(again[0].type).toBe('rejected'); expect(stack.portfolio.swaps).toHaveLength(count);
    if (skill) { await expect(helper('execute', plan.id)).rejects.toMatchObject({ code: 1 });
      expect(stack.portfolio.swaps).toHaveLength(count); }
    const records = await page.evaluate(async () => (await (await fetch('/gw/machine-credentials/portfolio')).json()).credentials);
    expect(records).toHaveLength(1);
    expect(records[0].agentId).toBe(stack.portfolio.id);
    const disk = readFileSync(join(stack.directory, 'gateway/.machine-auth', `${records[0].id}.json`), 'utf8');
    expect(disk).not.toContain(token); expect(disk).not.toContain(token.split('.').at(-1));
    stack.portfolio.setUnavailable(true);
    await expect(client.instance()).rejects.toThrow();
    // Listing and revoking read nothing from the provider, so both answer during its outage, after a reload too.
    await page.reload();
    const listed = await access('GET');
    expect(listed.body.credentials.map(c => c.label)).toEqual([label]);
    expect(JSON.stringify(listed.body)).not.toContain(token.split('.').at(-1));
    expect(await access('DELETE', records[0].id)).toEqual({ status: 200, body: { revoked: true } });
    expect((await access('GET')).body.credentials[0].revoked).toBe(true);
    stack.portfolio.setUnavailable(false);
    // Revoked: the credential no longer authenticates (401), even for a read it was granted.
    await expect(client.instance()).rejects.toMatchObject({ response: { status: 401 } });
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(wallet.unexpected).toEqual([]);
  } finally {
    await wallet.context.tracing.stop({ path: info.outputPath('access-trace.zip') });
    await wallet.context.close(); await stack.close();
  }
});
