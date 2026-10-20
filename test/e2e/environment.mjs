import { createServer as httpServer, request } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { activate, stage } from '../../src/contract/release-server.mjs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';
import { provider, listen, DAO, DAO_SIGNER, OWNER, PAYEE, SECOND } from './provider.mjs';

const root = resolve(import.meta.dirname, '../..');
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function freePort(host = '127.0.0.1') {
  const server = httpServer();
  await new Promise(resolve => server.listen(0, host, resolve));
  const port = server.address().port; await close(server); return port;
}
/**
 * `secondAccount`: SECOND exists on chain and the host allows sessions without an agent (account-switch scenarios).
 * `daoOwned`: the owner app's agent belongs to the simulated Sputnik DAO, whose council (OWNER) and member (SECOND)
 * can both read it with different permissions (shared-reader scenarios). Test-only: no authorization code changes.
 */
export async function environment(directory, { workspace = false, portfolioOwner = PAYEE, independentFrontend = false, frontendDist, ownerApp, owner = OWNER, payees = [PAYEE], secondAccount = false, daoOwned = false, accounts: extraAccounts = [], payoutFunding } = {}) {
  const daoArea = daoOwned ? ownerApp?.product : undefined;
  if (daoOwned && !['payables', 'treasury'].includes(daoArea)) throw new Error('daoOwned requires an owner app');
  if (daoArea === 'payables') owner = DAO;
  if (daoArea === 'treasury') { workspace = true; portfolioOwner = DAO; }
  mkdirSync(directory, { recursive: true });
  const services = [], proxies = [];
  const accounts = [...(secondAccount || daoOwned ? [SECOND] : []), ...(daoOwned ? [OWNER, DAO_SIGNER] : []), ...extraAccounts];
  // The gateway reads the chain through this simulator: it answers for the DAO whenever one owns an agent.
  const simulated = await provider(directory, { account: owner === DAO ? DAO_SIGNER : owner, payees, accounts, dao: daoOwned, ...(payoutFunding !== undefined && { payoutFunding }) });
  const portfolioDir = join(directory, 'portfolio');
  let portfolio;
  if (workspace) { mkdirSync(portfolioDir); portfolio = await provider(portfolioDir, { treasury: true, account: portfolioOwner === DAO ? DAO_SIGNER : portfolioOwner, accounts, dao: daoOwned }); }
  let executor, reviewer;
  const executorDir = join(directory, 'executor'), reviewerDir = join(directory, 'reviewer'), gatewayDir = join(directory, 'gateway');
  for (const dir of [executorDir, reviewerDir, gatewayDir]) mkdirSync(dir);
  const [executorPort, reviewerPort, gatewayPort, invoicePort] = await Promise.all([freePort(), freePort(), freePort(), freePort('::1')]);
  const key = join(directory, 'localhost.key'), cert = join(directory, 'localhost.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  async function proxy(port, host) {
    const server = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      const upstream = request({ host, port, method: req.method, path: req.url, headers: req.headers }, answer => {
        res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxies.push(server); return listen(server);
  }
  const dashboard = `https://127.0.0.1:${await proxy(gatewayPort, '127.0.0.1')}`;
  const invoices = `https://localhost:${await proxy(invoicePort, '::1')}`;
  // The actual Invoices release runs as its own process with no Proto configuration or credentials.
  let payeeFrontend, frontendProcess;
  const frontendProcesses = new Set();
  // The shared release server: a release is staged and activated without restarting the process.
  const invoicesReleases = join(directory, 'invoices-releases');
  mkdirSync(invoicesReleases);
  const frontendEnv = { HOST: '127.0.0.1', PORT: '', RELEASES_ROOT: invoicesReleases };
  const invoicesRelease = dist => activate(invoicesReleases, stage(invoicesReleases, dist)).id;
  async function startFrontend(dist = process.env.PROTO_E2E_INVOICES_DIST) {
    invoicesRelease(dist);
    const child = spawn(process.execPath, [join(import.meta.dirname, '../../src/contract/release-server.mjs')],
      { cwd: directory, env: frontendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    services.push(child); frontendProcesses.add(frontendProcess = child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; appendFileSync(join(directory, 'invoices-frontend.log'), chunk); });
    const deadline = Date.now() + 20_000;
    while (!/(Invoices|Release) asset server ready/.test(output)) {
      if (child.exitCode !== null || child.signalCode) { await new Promise(resolve => child.stderr.once('close', resolve)); throw new Error(`invoices frontend exited (${child.exitCode ?? child.signalCode}): ${output}`); }
      if (Date.now() > deadline) throw new Error(`invoices frontend startup timed out: ${output}`);
      await delay(50);
    }
  }
  // P2: an owner app's actual builds as releases A, B and an incompatible C, served by the shared release
  // server as its own process. Activation is the app operator's action, done here through the same code.
  let release;
  if (ownerApp) {
    const root = join(directory, 'releases'); mkdirSync(root);
    const incompatible = join(directory, 'release-c'); cpSync(ownerApp.a, incompatible, { recursive: true });
    const contract = JSON.parse(readFileSync(join(incompatible, 'contract.json'), 'utf8'));
    writeFileSync(join(incompatible, 'contract.json'), JSON.stringify({ ...contract, required: [...contract.required, `${ownerApp.product}-unknown-v9`] }));
    const ids = { a: stage(root, ownerApp.a), b: stage(root, ownerApp.b), c: stage(root, incompatible) };
    activate(root, ids.a);
    release = { root, ids, env: { HOST: '127.0.0.1', PORT: String(await freePort()), RELEASES_ROOT: root }, activate: name => activate(root, ids[name]) };
    const child = spawn(process.execPath, [join(import.meta.dirname, '../../src/contract/release-server.mjs')],
      { cwd: directory, env: release.env, stdio: ['ignore', 'pipe', 'pipe'] });
    services.push(child); frontendProcesses.add(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; appendFileSync(join(directory, 'release-server.log'), chunk); });
    for (const deadline = Date.now() + 20_000; !output.includes('Release asset server ready');) {
      if (child.exitCode !== null) throw new Error(`release server exited: ${output}`);
      if (Date.now() > deadline) throw new Error(`release server startup timed out: ${output}`);
      await delay(50);
    }
    release.origin = `http://127.0.0.1:${release.env.PORT}`;
  }
  const common = { ...offlineEnvironment(), NODE_OPTIONS: `--require ${JSON.stringify(join(root, 'test/fixtures/offline-network.cjs'))} --require ${JSON.stringify(join(root, 'test/e2e/fastnear-fixture.cjs'))}`, AGENT_ID: simulated.id, AGENT_GRANT_TOKEN: simulated.token,
    NEAR_INTENTS_AGENT_API_URL: simulated.url, NEAR_RPC_URL: `${simulated.url}/chain`, AUTOPILOT: 'off',
    SESSION_SECRET: 'local-only-session-secret-with-more-than-32-characters', DASHBOARD_AREA: 'payables', ...(payeeFrontend && { INVOICES_FRONTEND_URL: payeeFrontend }) };
  async function start(name, cwd, entry, env, ready) {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, entry)], { cwd, env: { ...common, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    services.push(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk; appendFileSync(join(directory, `${name}.log`), chunk);
    });
    const deadline = Date.now() + 20_000;
    while (!output.includes(ready)) {
      if (child.exitCode !== null || child.signalCode) throw new Error(`${name} exited: ${output}`);
      if (Date.now() > deadline) throw new Error(`${name} startup timed out: ${output}`);
      await delay(50);
    }
    return child;
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode) return;
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  }
  const startExecutor = async () => executor = await start('executor', executorDir, 'src/server.ts', {
    PORT: String(executorPort), EXECUTOR: 'on', INVOICES_PORT: String(invoicePort), INVOICES_HOST: '::1',
    INVOICES_PUBLIC_HOST: new URL(invoices).host, INVOICES_SESSION_SECRET: 'local-only-invoice-secret-kept-across-restarts',
    AGREEMENTS_SECRET: 'local-agreements',
  }, 'Treasury dashboard on');
  // A valid test grant makes executor enforcement observable independently of missing credentials.
  const startReviewer = async () => reviewer = await start('reviewer', reviewerDir, 'src/server.ts', { PORT: String(reviewerPort), EXECUTOR: 'off', AGENT_GRANT_TOKEN: simulated.token,
      AGREEMENTS_URL: `http://[::1]:${invoicePort}`, AGREEMENTS_SECRET: 'local-agreements' }, 'Treasury dashboard on');
  async function dispose() {
    await Promise.all(services.map(stop));
    await Promise.all(proxies.map(close));
    await simulated.close();
    if (portfolio) await portfolio.close();
  }
  try {
    if (process.env.PROTO_E2E_INVOICES_DIST) {
      // A concurrent stack can take a probed port before the child binds it: the first start retries
      // on a fresh port. Later releases keep this port, which the gateway is configured with.
      for (let attempt = 1; ; attempt++) {
        frontendEnv.PORT = String(await freePort());
        try { await startFrontend(); break; } catch (error) { if (attempt === 3) throw error; }
      }
      common.INVOICES_FRONTEND_URL = payeeFrontend = `http://127.0.0.1:${frontendEnv.PORT}`;
    }
    await startExecutor();
    await startReviewer();
    const agents = [{ name: 'payout', owner, area: 'payables', port: reviewerPort, executor: false, invoices: `${invoices}/submit` }];
    if (portfolio) {
      const port = await freePort();
      await start('portfolio', portfolioDir, 'src/server.ts', { PORT: String(port), EXECUTOR: 'on',
        AGENT_ID: portfolio.id, AGENT_GRANT_TOKEN: portfolio.token, NEAR_INTENTS_AGENT_API_URL: portfolio.url,
        DASHBOARD_AREA: 'treasury' }, 'Treasury dashboard on');
      // An obsolete operator list is ignored; only the actual owner can access this wallet's agent.
      agents.push({ name: 'portfolio', owner: portfolioOwner, operators: [OWNER], area: 'treasury', port, executor: true });
    }
    const frontend = join(directory, 'independent-frontend');
    if (independentFrontend) {
      mkdirSync(frontend); writeFileSync(join(frontend, 'index.html'), '<h1>Independent Treasury frontend</h1>');
    }
    writeFileSync(join(gatewayDir, 'dashboard.json'), JSON.stringify({ host: new URL(dashboard).host, invoices,
      ...(independentFrontend && { hosts: { [new URL(dashboard).host]: {
        demo: 'treasury', agents: agents.map(a => a.name), frontendDist: frontend } } }),
      // A new prototype's own build on this host, using the existing showcase assignment.
      ...(frontendDist && { hosts: { [new URL(dashboard).host]: { demo: 'showcase', agents: agents.map(a => a.name), frontendDist } } }),
      ...(release && { hosts: { [new URL(dashboard).host]: { demo: ownerApp.product, agents: agents.filter(a => a.area === ownerApp.product).map(a => a.name), frontend: { origin: release.origin, product: ownerApp.product } } } }), ...(secondAccount && { selfService: true }), agents }));
    await start('gateway', gatewayDir, 'src/gateway/server.ts', { PORT: String(gatewayPort), AGENT_GRANT_TOKEN: '',
      DASHBOARD_FILE: join(gatewayDir, 'dashboard.json') }, 'on port');
  } catch (error) { await dispose(); throw error; }
  function records() {
    if (!existsSync(join(executorDir, '.invoices', `${simulated.id}.sqlite`))) return { invoices: [], revisions: [], payments: [], reservations: [] };
    const db = new DatabaseSync(join(executorDir, '.invoices', `${simulated.id}.sqlite`), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000; BEGIN');
      return Object.fromEntries(['invoices', 'revisions', 'payments', 'reservations'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    } finally { db.close(); }
  }
  return { dashboard, invoices, simulated, portfolio, directory, records,
    portfolioState() {
      const read = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
      return { strategy: JSON.parse(read(join(portfolioDir, '.strategy/.env.json')) ?? 'null'),
        settings: read(join(portfolioDir, '.env')), owner: JSON.parse(read(join(portfolioDir, '.owner-intents/.env.json')) ?? '{}') };
    },
    ownerRecords() { const path = join(reviewerDir, '.owner-intents', '.env.json'); return existsSync(path) ? JSON.parse(readFileSync(path)) : {}; },
    async restartExecutor() { await stop(executor); await startExecutor(); },
    async restartReviewer() { await stop(reviewer); await startReviewer(); },
    release, frontendEnv, protoPids: () => services.filter(c => !frontendProcesses.has(c)).map(c => c.pid),
    async stopFrontend() { await stop(frontendProcess); },
    async releaseFrontend(dist) {
      if (frontendProcess.exitCode !== null || frontendProcess.signalCode) return startFrontend(dist);
      return invoicesRelease(dist);
    },
    async close() { await dispose(); writeFileSync(join(directory, 'observations.json'), JSON.stringify({ requests: simulated.requests, errors: simulated.errors, records: records(), owner: this.ownerRecords(), portfolio: portfolio ? { requests: portfolio.requests, errors: portfolio.errors, grants: portfolio.grants, state: this.portfolioState() } : null, browser: this.browserVersion ?? null }, null, 2)); },
  };
}
