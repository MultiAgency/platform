import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { supplierEnvironment, supplierCookie } from '../../src/gateway/hosted-supplier.js';
import { sessionToken } from '../../src/signin.js';
import { chromium } from 'playwright';
import { generateKey, Near, type PrivateKey } from 'near-kit';

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
const area = process.env.SHARED_FRONTEND_AREA ?? 'treasury';
const host = `${area}.test`;
test(`independent ${area} build signs into the real gateway and keeps reads host/owner scoped`, { timeout: 90_000 }, async t => {
  const runtime = process.env.SHARED_RUNTIME_ROOT ?? process.cwd();
  const dist = process.env.SHARED_FRONTEND_DIST!;
  const directory = mkdtempSync(join(tmpdir(), 'treasury-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = generateKey();
  const near = new Near({ network: 'mainnet', privateKey: key.secretKey as PrivateKey, defaultSignerId: 'alice.near' });
  const reads: string[] = [];
  let ready = false;
  const { setup, overview } = createRequire(import.meta.url)('../browser/fixtures/workspace.cjs').workspaceEvidence();
  const agent = createServer((req, res) => {
    const path = req.url!;
    reads.push(path);
    const values: Record<string, unknown> = {
      '/rpc/ownerIdentity': { agentId: null, owner: null },
      '/rpc/setup': { agentId: null, wallet: null, owner: null, grant: null, dao: null, executor: true },
      '/rpc/owner/actions': [],
      ...(area === 'payables' ? { '/rpc/overview': null, '/rpc/held': [], '/rpc/autopilot/get': { on: false }, '/rpc/unresolved': [], '/rpc/agreements/list': [], '/rpc/inbox/list': [] } : {}),
      '/rpc/instance': { agentId: null, executor: true },
    };
    if (ready) Object.assign(values, {
      '/rpc/setup': { ...setup, owner: { type: 'near', account_id: 'alice.near' } },
      '/rpc/overview': overview('facilitator'), '/rpc/instance': { agentId: 'fixture', executor: false },
      '/rpc/treasury/get': null, '/rpc/invoices': [], '/rpc/activity': [], '/rpc/owner/pending': [],
      '/rpc/compensation/list': { agreements: [], requests: [], history: [], payments: [] },
      '/rpc/paymentHistory': { items: [], complete: true }, '/rpc/workOrders/list': [order],
      '/rpc/workOrders/get': { order, agentId: null, wallet: null, balance: null, policyReady: false, grant: null, invoice: null, ownerActions: [], approval: null, error: null },
    });
    res.writeHead(path in values ? 200 : 500, { 'content-type': 'application/json' }).end(JSON.stringify({ json: path in values ? values[path] : 'Unexpected procedure' }));
  });
  const agentPort = await listen(agent); t.after(() => agent.close());
  const linkedAgent = createServer((req, res) => { agent.emit('request', req, res); });
  const linkedPort = await listen(linkedAgent); t.after(() => linkedAgent.close());
  const chain = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk).on('end', () => {
      const { id, params } = JSON.parse(body);
      const answer = params.request_type === 'view_access_key' && ['alice.near', 'bob.near'].includes(params.account_id) && params.public_key === key.publicKey.toString()
        ? { result: { permission: 'FullAccess', nonce: 0, block_height: 1, block_hash: '11111111111111111111111111111111' } }
        : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error' } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
    });
  });
  const chainPort = await listen(chain); t.after(() => chain.close());
  const provider = createServer((req, res) => {
    if (req.method === 'GET' && req.url === `/v1/agents/${'b'.repeat(64)}`) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ owner: { type: 'near', account_id: 'bob.near' } }));
    } else if (req.method === 'GET' && req.url === `/v1/agents/${'b'.repeat(64)}/policy`) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ policy: null }));
    } else res.writeHead(503).end('No provider actions in this fixture');
  });
  const providerPort = await listen(provider); t.after(() => provider.close());

  const probe = createServer(); const port = await listen(probe); await new Promise<void>(resolve => probe.close(() => resolve()));
  writeFileSync(join(directory, 'dashboard.json'), JSON.stringify({ host, invoices: 'https://legacy-intake.test/', selfService: true, hosts: {
    [host]: { demo: area, agents: area === 'payables' ? ['treasury', 'linked-payout'] : ['treasury'], hostedAreas: [area], frontendDist: dist },
    'invoices.test': { demo: 'invoices', agents: [], hostedAreas: ['payables'] },
    'other.test': { demo: 'showcase', agents: ['treasury'] },
  }, agents: [{ name: 'treasury', owner: 'alice.near', area, port: agentPort, executor: false }, ...(area === 'payables' ? [{ name: 'linked-payout', owner: 'alice.near', area: 'payables', port: linkedPort, executor: false, invoices: 'https://invoices.test/submit?source=agency' }] : [])] }));
  const startGateway = () => spawn(process.execPath, ['--import', join(runtime, 'node_modules/tsx/dist/loader.mjs'), join(runtime, 'src/gateway/server.ts')], {
    cwd: directory, env: { ...process.env, PORT: String(port), SESSION_SECRET: 'offline-shared-frontend-secret-123456789', NEAR_RPC_URL: `http://127.0.0.1:${chainPort}`, NEAR_INTENTS_AGENT_API_URL: `http://127.0.0.1:${providerPort}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gateway = startGateway();
  t.after(async () => { if (gateway.exitCode === null) { gateway.kill(); await new Promise(resolve => gateway.once('exit', resolve)); } });
  let diagnostics = '';
  const waitGateway = async () => {
  gateway.stderr!.on('data', chunk => diagnostics += chunk);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(diagnostics || 'Gateway did not start')), 10_000);
    gateway.stdout!.on('data', chunk => { if (String(chunk).includes('on port')) { clearTimeout(timer); resolve(); } });
    gateway.once('exit', () => { clearTimeout(timer); reject(new Error(diagnostics)); });
  });
  };
  await waitGateway();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  await context.routeWebSocket('**/*', socket => socket.close());
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  let badDiscovery = false;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let walletAccount = 'alice.near';
  await page.exposeFunction('fixtureSign', async (value: { message: string; recipient: string; nonce: number[] }) => {
    const signed = await near.signMessage({ ...value, nonce: new Uint8Array(value.nonce) });
    return { ...signed, accountId: walletAccount };
  });
  // Raw JavaScript avoids TypeScript/esbuild helper references in the browser realm.
  await page.addInitScript({ content: `(() => {
    if (location.protocol !== 'https:') return;
    localStorage.setItem('member:selected-wallet:mainnet', 'fixture-wallet');
    localStorage.setItem('selected-wallet:mainnet', 'fixture-wallet');
    const accounts = [{ accountId: localStorage.getItem('fixture-account') || 'alice.near' }];
    const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} },
      getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
      signMessage: async value => window.fixtureSign({ ...value, nonce: Array.from(value.nonce) }),
      signDelegateActions: async () => { throw new Error('No owner signing in this test'); },
      signAndSendTransaction: async () => { throw new Error('No transaction in this test'); } };
    window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
  })();` });
  let managedPresentation: string | undefined;
  const orderId = '12345678-1234-4234-8234-123456789abc';
  const order = { version: 1, id: orderId, parentAgentId: 'b'.repeat(64), payee: 'supplier.near', amount: '1250000', note: 'Offline packaged work', until: '2030-01-01T00:00:00.000Z', createdAt: '2026-10-15T00:00:00.000Z', asset: 'usdc', owner: { type: 'near', account_id: 'bob.near', public_key: 'fixture' } };
  const supplierRequests: string[] = [];
  // Browser traffic reaches the real gateway over loopback. Everything else is blocked.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://cdn.jsdelivr.net/npm/@fastnear/near-connect@0.14.1/+esm') return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/javascript', body: 'export class NearConnector { connect() { throw new Error("Supplier wallet signing disabled in fixture"); } disconnect() {} }' });
    if (![host, 'other.test', 'invoices.test'].includes(url.hostname)) return route.abort();
    if (url.hostname === 'invoices.test') supplierRequests.push(url.pathname + url.search);
    // Presentation observations only. Discovery, admission and supplier routing use the real gateway.
    if (managedPresentation && url.pathname.startsWith(`/a/${managedPresentation}/rpc/`)) {
      const method = url.pathname.split('/rpc/')[1]!;
      const values: Record<string, unknown> = {
        setup: { ...setup, owner: { type: 'near', account_id: 'bob.near' } }, overview: overview('facilitator'), instance: { agentId: 'b'.repeat(64), executor: false },
        'owner/actions': [], 'owner/pending': [], 'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], invoices: [], activity: [],
        'compensation/list': { agreements: [], requests: [], history: [], payments: [] },
        paymentHistory: { items: [], complete: true }, 'autopilot/get': { on: false }, 'workOrders/list': [order],
        'workOrders/get': { order, agentId: null, wallet: null, balance: null, policyReady: false, grant: null, invoice: null, ownerActions: [], approval: null, error: null },
      };
      assert.ok(method in values, `Unexpected presentation procedure: ${method}`);
      return route.fulfill({ json: { json: values[method] } });
    }
    if (badDiscovery && url.pathname === '/gw/me') return route.fulfill({ contentType: 'text/html', body: '<html>Misconfigured static fallback</html>' });
    const answer = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const headers = { ...route.request().headers(), host: url.host }; delete (headers as Record<string, string>).connection;
      const upstream = request({ hostname: '127.0.0.1', port, method: route.request().method(), path: url.pathname + url.search, headers }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)).on('end', () => resolve({ status: res.statusCode!, headers: Object.fromEntries(Object.entries(res.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)])), body: Buffer.concat(chunks) }));
      }); upstream.on('error', reject); upstream.end(route.request().postDataBuffer());
    });
    await route.fulfill(answer);
  });
  await page.goto(`https://${host}/`);
  await page.getByRole('button', { name: area === 'treasury' ? 'Connect wallet' : 'Connect wallet to start', exact: true }).first().waitFor();
  assert.ok(await page.title());
  assert.equal(reads.length, 0, 'public entry reads no agent');
  await page.getByRole('button', { name: area === 'treasury' ? 'Connect wallet' : 'Connect wallet to start', exact: true }).first().click();
  await page.getByRole('heading', { name: area === 'treasury' ? 'Create your Treasury' : 'Set up your Payables agent', exact: true }).waitFor().catch(async error => { throw new Error(`${error}\nPage: ${await page.locator('body').innerText()}\nGateway: ${diagnostics}\nBrowser errors: ${errors.join("; ")}`); });
  await page.getByRole('link', { name: area === 'treasury' ? 'alice.near' : 'Review agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).waitFor().catch(async error => { throw new Error(`${error}\n${await page.locator('body').innerText()}\nReads: ${reads.join(', ')}\nErrors: ${errors.join('; ')}`); });
  assert.ok(reads.includes('/rpc/setup'));
  assert.deepEqual(await page.evaluate(async () => (await fetch('/a/treasury/rpc/instance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()), { json: { agentId: null, executor: true } });
  assert.equal(await page.evaluate(async () => (await fetch('/a/missing/rpc/instance', { method: 'POST', body: '{}' })).status), 404);
  // No owner intent, plan or money procedure was requested.
  assert.ok(reads.every(path => ['/rpc/ownerIdentity', '/rpc/setup', '/rpc/owner/actions', '/rpc/instance', ...(area === 'payables' ? ['/rpc/overview', '/rpc/held', '/rpc/autopilot/get', '/rpc/unresolved', '/rpc/agreements/list', '/rpc/inbox/list'] : [])].includes(path)));
  if (area === 'payables') {
    ready = true;
    await page.goto(`https://${host}/a/treasury/payees`);
    await page.getByText("This agent's invoice page address is not configured here.", { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open invoice page', exact: true }).count(), 0);
    assert.equal(await page.locator('a[href^="https://legacy-intake.test"]').count(), 0);
    await page.goto(`https://${host}/a/linked-payout/payees`);
    const view = await page.evaluate(async () => (await fetch('/gw/me')).json());
    assert.equal(view.agents.find((a: {name: string}) => a.name === 'linked-payout').invoices, 'https://invoices.test/submit?source=agency');
    assert.equal(view.agents.find((a: {name: string}) => a.name === 'treasury').invoices, undefined);
    assert.equal(await page.getByRole('link', { name: 'Open invoice page', exact: true }).getAttribute('href'), 'https://invoices.test/submit?source=agency');
    await page.getByRole('button', { name: 'Review work order', exact: true }).click();
    const staticLink = page.getByRole('link', { name: 'Open work order on the invoice page', exact: true });
    assert.equal(await staticLink.getAttribute('href'), `https://invoices.test/submit?source=agency&workOrder=${orderId}`);
    await page.reload();
    await page.getByRole('button', { name: 'Review work order', exact: true }).click();
    assert.equal(await staticLink.getAttribute('href'), `https://invoices.test/submit?source=agency&workOrder=${orderId}`);

  }
  await page.evaluate(async () => { await fetch('/gw/logout', { method: 'POST' }); });
  assert.equal(await page.evaluate(async () => (await fetch('/a/treasury/rpc/instance', { method: 'POST', body: '{}' })).status), 401);
  const bobChallenge = await page.evaluate(async () => (await fetch('/gw/challenge')).json());
  const bobSigned = await near.signMessage({ ...bobChallenge, nonce: Buffer.from(bobChallenge.nonce, 'base64') });
  const bobStatus = await page.evaluate(async body => (await fetch('/gw/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, { ...bobSigned, accountId: 'bob.near', nonce: bobChallenge.nonce });
  assert.equal(bobStatus, 200);
  assert.equal(await page.evaluate(async () => (await fetch('/a/treasury/rpc/instance', { method: 'POST', body: '{}' })).status), 403);
  if (area === 'payables') {
    walletAccount = 'bob.near';
    await page.evaluate(() => localStorage.setItem('fixture-account', 'bob.near'));
    await page.goto(`https://${host}/`);
    const reservationResponse = page.waitForResponse(response => response.url().endsWith('/gw/agents') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Continue to Payables setup', exact: true }).click();
    const response = await reservationResponse;
    assert.equal(response.status(), 200);
    assert.deepEqual(response.request().postDataJSON(), { owner: 'bob.near', kind: 'wallet', area: 'payables' });
    await page.waitForURL(url => /^\/a\/own-[0-9a-f]{24}\/$/.test(url.pathname));
    const name = new URL(page.url()).pathname.split('/')[2];
    let admitted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const view = await page.evaluate(async () => (await fetch('/gw/me')).json());
      if (view.viewer?.access[name!]) { admitted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(admitted, diagnostics);
    await page.reload();
    const discovery = await page.evaluate(async () => (await fetch('/gw/me')).json());
    assert.equal(discovery.agents.length, 1, JSON.stringify({ discovery, diagnostics, body: await page.locator('body').innerText() }));
    assert.equal(discovery.agents[0].name, name);
    assert.equal(discovery.agents[0].invoices, `https://invoices.test/i/${name}/`);
    assert.equal(discovery.agents[0].managed, true);
    // Fixture-only restart: assign an offline identity so the actual supplier handler can start.
    await page.goto('about:blank');
    gateway.kill(); await new Promise(resolve => gateway.once('exit', resolve));
    const settings = join(directory, '.hosted', `${name}.env`);
    writeFileSync(settings, readFileSync(settings, 'utf8') + `AGENT_ID=${'b'.repeat(64)}\n`);
    const ordersDirectory = join(directory, '.work-orders', 'b'.repeat(64));
    mkdirSync(ordersDirectory, { recursive: true });
    writeFileSync(join(ordersDirectory, `${orderId}.json`), JSON.stringify(order));
    writeFileSync(join(ordersDirectory, '22345678-1234-4234-8234-123456789abc.json'), JSON.stringify({ ...order, id: '22345678-1234-4234-8234-123456789abc', note: 'Another order must not be selected' }));
    gateway = startGateway(); await waitGateway();
    managedPresentation = name;
    await page.goto(`https://${host}/a/${name}/payees`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const view = await page.evaluate(async () => (await fetch('/gw/me')).json());
      if (view.viewer?.access[name!]) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await page.goto(`https://${host}/a/${name}/payees`);
    assert.equal(await page.getByRole('link', { name: 'Open invoice page', exact: true }).getAttribute('href'), `https://invoices.test/i/${name}/`);
    await page.getByRole('button', { name: 'Review work order', exact: true }).click();
    const link = page.getByRole('link', { name: 'Open work order on the invoice page', exact: true });
    const href = await link.getAttribute('href');
    assert.equal(href, `https://invoices.test/i/${name}/?workOrder=${orderId}`);
    const supplier = await context.newPage();
    await supplier.goto(href!);
    // Startup may initially return 502 while the isolated child opens its listener.
    for (let attempt = 0; attempt < 100 && !(await supplier.locator('#signin').count()); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100)); await supplier.reload();
    }
    assert.ok((await supplier.content()).includes(`/i/${name}/invoice-browser.js`));
    assert.equal(new URL(supplier.url()).searchParams.get('workOrder'), orderId);
    await supplier.reload();
    assert.equal(new URL(supplier.url()).searchParams.get('workOrder'), orderId);
    assert.ok(supplierRequests.includes(`/i/${name}/?workOrder=${orderId}`));
    assert.equal(await supplier.evaluate(async () => (await fetch('/i/own-' + 'f'.repeat(24) + '/api/work-orders')).status), 404);
    assert.equal(await supplier.evaluate(async base => (await fetch(base + 'api/work-orders')).status, `/i/${name}/`), 401);
    const supplierEnv = supplierEnvironment({ name: name!, owner: 'bob.near', kind: 'wallet', area: 'payables', port: 9000, executor: true, envFile: 'unused' }, 'invoices.test', 'offline-shared-frontend-secret-123456789');
    await context.addCookies([{ name: supplierCookie(name!), value: sessionToken('supplier.near', supplierEnv.INVOICES_SESSION_SECRET!), domain: 'invoices.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await supplier.reload();
    await supplier.locator('#work-order-note').filter({ hasText: 'Offline packaged work' }).waitFor();
    assert.ok(supplierRequests.includes(`/i/${name}/api/work-orders/${orderId}`));
    assert.equal(await supplier.locator('#work-order-note').innerText(), 'Offline packaged work');
    await supplier.reload();
    await supplier.locator('#work-order-note').filter({ hasText: 'Offline packaged work' }).waitFor();
    assert.equal(new URL(supplier.url()).searchParams.get('workOrder'), orderId);
    assert.equal(await supplier.locator('#work-order-file').isDisabled(), true, 'unfunded fixture cannot file a payment');
    await supplier.close();


  }
  await page.goto('https://other.test/gw/me');
  assert.equal(JSON.parse(await page.locator('body').innerText()).viewer, null, 'session never crosses hosts');
  const beforeBadDiscovery = reads.length;
  badDiscovery = true;
  await page.goto(`https://${host}/a/treasury/`);
  await page.getByRole('heading', { name: 'Dashboard unavailable', exact: true }).waitFor();
  assert.equal(reads.length, beforeBadDiscovery, 'HTML discovery never mounts trusted agent reads');
  assert.deepEqual(errors, []);
});
