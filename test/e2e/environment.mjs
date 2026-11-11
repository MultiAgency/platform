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
import { market as simulatedMarket } from './market.mjs';
import { tsImport } from 'tsx/esm/api';

/**
 * Offline owner-strategy fixture for `portfolio`: the strategy written straight to its file, and, with `authorized`,
 * the simulated grant relabelled as the owner's grant for it (`treasury:<suffix>`), which a machine credential's plans
 * need. Stands in for the owner saving and signing through the dashboard; `authorizeStrategy` signs for real.
 */
export async function strategyFixture(stack, strategy, { authorized = true } = {}) {
  const { Strategy, strategyLabelSuffix } = await tsImport('../../src/strategy-digest.ts', import.meta.url);
  const parsed = Strategy.parse(strategy), dir = join(stack.directory, 'portfolio/.strategy');
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '.env.json'), JSON.stringify(parsed));
  if (authorized) for (const grant of stack.portfolio.grants) { grant.label = `treasury:${strategyLabelSuffix(parsed)}`; grant.owner_message.label = grant.label; }
}

const root = resolve(import.meta.dirname, '../..');
/** Every service the stack starts ends with whatever started it. Agent servers take it through NODE_OPTIONS, which a
 * gateway's hosted agents inherit; release servers through their arguments, so their environment stays exactly theirs. */
const EXIT_WITH_PARENT_FILE = join(root, 'test/e2e/exit-with-parent.cjs');
const EXIT_WITH_PARENT = `--require ${JSON.stringify(EXIT_WITH_PARENT_FILE)}`;
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
/**
 * The gateway serves the confirm page from this checkout's web build. Without it the page loads blank or 404s and a
 * test waits on a button that never comes, so the stack refuses to start, naming the build to run.
 */
export async function requireConfirmBuild(dist = join(root, 'web/dist')) {
  const { missingConfirmFiles } = await tsImport('../../src/gateway/app-confirm.ts', import.meta.url);
  const missing = missingConfirmFiles(dist);
  if (missing.length) throw new Error(`The confirm page's web build is missing or incomplete in ${dist} (no ${missing.join(', ')}). Run \`pnpm build:web\` in ${root} first.`);
}
async function freePort(host = '127.0.0.1') {
  const server = httpServer();
  await new Promise(resolve => server.listen(0, host, resolve));
  const port = server.address().port; await close(server); return port;
}
/**
 * `secondAccount`: SECOND exists on chain and the host allows sessions without an agent.
 * `onChainPolicyEdits`: the simulator signs freeze, unfreeze and provider-enforced policy edits as NEP-366 (see provider.mjs).
 * `daoPortfolio`: the Treasury agent (`portfolio`) belongs to the simulated DAO, without an owner app: apps reach it only
 *   under a DAO's consent, and its owner actions are DAO votes the `daoVote` control passes.
 * `headless`: the gateway runs as the platform does (`deploy/platform*.json`): app access and the confirm page only,
 *   app setup for the areas `appSetup` lists (Payables, as on `platform.json`; Treasury too on `platform-staging.json`);
 *   no sign-in, owner app or contributor intake on its host.
 * `selfService`: owners (on the host) and app deployments (through `/apps/v1/setup`) may set up hosted agents; `hostedAreas` names the
 * areas a `frontendDist` host may set up.
 * `market`: a simulated agent market (market.mjs, docs/market.md) the gateway's hosted agents hire on: `true` for two
 *   listed agents, `writer` (delivers) and `refuser` (rejects every task), or its own `{ handle: { amount, windowSeconds,
 *   outcome, result } }`. The stand-in Agent API lands a market agent's top-ups on its chain. Add `market` to `appSetup`.
 */
const MARKET_AGENTS = { writer: { amount: '500000', windowSeconds: 600, outcome: 'complete', result: 'the article' },
  refuser: { amount: '500000', windowSeconds: 600, outcome: 'reject' } };
export async function environment(directory, { workspace = false, portfolioOwner = PAYEE, independentFrontend = false, frontendDist, ownerApp, owner = OWNER, payees = [PAYEE], secondAccount = false, daoPortfolio = false, accounts: extraAccounts = [], payoutFunding, onChainPolicyEdits = false, selfService = false, hostedAreas = [], headless = false, appSetup = ['payables'], market = false } = {}) {
  await requireConfirmBuild();
  if (daoPortfolio) { workspace = true; portfolioOwner = DAO; }
  const dao = daoPortfolio;
  mkdirSync(directory, { recursive: true });
  const services = [], proxies = [];
  const accounts = [...(secondAccount || dao ? [SECOND] : []), ...(dao ? [OWNER, DAO_SIGNER] : []), ...extraAccounts];
  const marketSim = market ? await simulatedMarket({ agents: market === true ? MARKET_AGENTS : market }) : null;
  // The gateway reads the chain through this simulator: it answers for the DAO whenever one owns an agent.
  const simulated = await provider(directory, { account: owner === DAO ? DAO_SIGNER : owner, payees, accounts, dao, onChainPolicyEdits, market: marketSim, ...(payoutFunding !== undefined && { payoutFunding }) });
  const portfolioDir = join(directory, 'portfolio');
  let portfolio;
  if (workspace) { mkdirSync(portfolioDir); portfolio = await provider(portfolioDir, { treasury: true, account: portfolioOwner === DAO ? DAO_SIGNER : portfolioOwner, accounts, dao, onChainPolicyEdits }); simulated.shareChain(portfolio); }
  let executor, reviewer;
  const executorDir = join(directory, 'executor'), reviewerDir = join(directory, 'reviewer'), gatewayDir = join(directory, 'gateway');
  for (const dir of [executorDir, reviewerDir, gatewayDir]) mkdirSync(dir);
  // Each port is probed on the address its service binds: the gateway listens on every interface (`::`), and a port free
  // on 127.0.0.1 can still be held there by another process (macOS allows both binds), so its start would fail.
  const [executorPort, reviewerPort, invoicePort] = await Promise.all([freePort(), freePort(), freePort('::1')]);
  let gatewayPort = await freePort('::');
  const key = join(directory, 'localhost.key'), cert = join(directory, 'localhost.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  // `target` is read per request: the gateway may start on a later port than the one first probed.
  async function proxy(target, host) {
    const server = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      const upstream = request({ host, port: target(), method: req.method, path: req.url, headers: req.headers }, answer => {
        res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxies.push(server); return listen(server);
  }
  // The gateway listens on the wildcard `::`. On macOS another process can still listen on 127.0.0.1 at the same port
  // (a browser's DevTools endpoint, say), before or after it, and then takes every connection to 127.0.0.1 there: a
  // page showed "WebSockets request was expected" (docs/testing.md). Over ::1 only the gateway answers.
  const dashboard = `https://127.0.0.1:${await proxy(() => gatewayPort, '::1')}`;
  const invoices = `https://localhost:${await proxy(() => invoicePort, '::1')}`;
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
    const child = spawn(process.execPath, ['--require', EXIT_WITH_PARENT_FILE, join(import.meta.dirname, '../../src/contract/release-server.mjs')],
      { cwd: directory, env: release.env, stdio: ['ignore', 'pipe', 'pipe'] });
    services.push(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; appendFileSync(join(directory, 'release-server.log'), chunk); });
    for (const deadline = Date.now() + 20_000; !output.includes('Release asset server ready');) {
      if (child.exitCode !== null) throw new Error(`release server exited: ${output}`);
      if (Date.now() > deadline) throw new Error(`release server startup timed out: ${output}`);
      await delay(50);
    }
    release.origin = `http://127.0.0.1:${release.env.PORT}`;
  }
  const common = { ...offlineEnvironment(), NODE_OPTIONS: `--require ${JSON.stringify(join(root, 'test/fixtures/offline-network.cjs'))} --require ${JSON.stringify(join(root, 'test/e2e/fastnear-fixture.cjs'))} ${EXIT_WITH_PARENT}`, AGENT_ID: simulated.id, AGENT_GRANT_TOKEN: simulated.token,
    NEAR_INTENTS_AGENT_API_URL: simulated.url, NEAR_RPC_URL: `${simulated.url}/chain`, AUTOPILOT: 'off',
    SESSION_SECRET: 'local-only-session-secret-with-more-than-32-characters', DASHBOARD_AREA: 'payables', ...(marketSim && { MARKET_URL: marketSim.url }) };
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
    await marketSim?.close();
  }
  try {
    await startExecutor();
    await startReviewer();
    const agents = [{ name: 'payout', owner, area: 'payables', port: reviewerPort, executor: false, invoices: `${invoices}/submit` }];
    if (portfolio) {
      const port = await freePort();
      await start('portfolio', portfolioDir, 'src/server.ts', { PORT: String(port), EXECUTOR: 'on',
        AGENT_ID: portfolio.id, AGENT_GRANT_TOKEN: portfolio.token, NEAR_INTENTS_AGENT_API_URL: portfolio.url,
        DASHBOARD_AREA: 'treasury', ...(daoPortfolio && { TREASURY_ACCOUNT: DAO }) }, 'Treasury dashboard on');
      // An obsolete operator list is ignored; only the actual owner can access this wallet's agent.
      agents.push({ name: 'portfolio', owner: portfolioOwner, operators: [OWNER], area: 'treasury', port, executor: true });
    }
    const frontend = join(directory, 'independent-frontend');
    if (independentFrontend) {
      mkdirSync(frontend); writeFileSync(join(frontend, 'index.html'), '<h1>Independent Treasury frontend</h1>');
    }
    writeFileSync(join(gatewayDir, 'dashboard.json'), JSON.stringify(headless ? { host: new URL(dashboard).host, headless: true, appSetup, agents } : { host: new URL(dashboard).host, invoices,
      ...(independentFrontend && { hosts: { [new URL(dashboard).host]: {
        demo: 'treasury', agents: agents.map(a => a.name), frontendDist: frontend } } }),
      // A new prototype's own build on this host, using the existing showcase assignment.
      ...(frontendDist && { hosts: { [new URL(dashboard).host]: { demo: 'showcase', agents: agents.map(a => a.name), frontendDist, hostedAreas } } }),
      ...(release && { hosts: { [new URL(dashboard).host]: { demo: ownerApp.product, agents: agents.filter(a => a.area === ownerApp.product).map(a => a.name), frontend: { origin: release.origin, product: ownerApp.product } } } }), ...((secondAccount || selfService) && { selfService: true, appSetup: ['treasury', 'payables', ...(marketSim ? ['market'] : [])] }), agents }));
    // Another process can take the probed port before the gateway binds it: only that failure retries, on a fresh
    // port. The dashboard proxy forwards to whichever port the gateway took; the host it signs in to is the proxy's.
    for (let attempt = 1; ; attempt++) {
      try {
        await start('gateway', gatewayDir, 'src/gateway/server.ts', { PORT: String(gatewayPort), AGENT_GRANT_TOKEN: '',
          DASHBOARD_FILE: join(gatewayDir, 'dashboard.json') }, 'on port');
        break;
      } catch (error) {
        if (attempt === 3 || !String(error.message).includes('EADDRINUSE')) throw error;
        gatewayPort = await freePort('::');
      }
    }
  } catch (error) { await dispose(); throw error; }
  function records() {
    if (!existsSync(join(executorDir, '.invoices', `${simulated.id}.sqlite`))) return { invoices: [], revisions: [], payments: [], reservations: [] };
    const db = new DatabaseSync(join(executorDir, '.invoices', `${simulated.id}.sqlite`), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000; BEGIN');
      return Object.fromEntries(['invoices', 'revisions', 'payments', 'reservations'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    } finally { db.close(); }
  }
  return { dashboard, invoices, simulated, portfolio, directory, records, market: marketSim,
    portfolioState() {
      const read = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
      return { strategy: JSON.parse(read(join(portfolioDir, '.strategy/.env.json')) ?? 'null'),
        settings: read(join(portfolioDir, '.env')), owner: JSON.parse(read(join(portfolioDir, '.owner-intents/.env.json')) ?? '{}') };
    },
    ownerRecords() { const path = join(reviewerDir, '.owner-intents', '.env.json'); return existsSync(path) ? JSON.parse(readFileSync(path)) : {}; },
    async restartExecutor() { await stop(executor); await startExecutor(); },
    async restartReviewer() { await stop(reviewer); await startReviewer(); },
    /** Every process this stack started that is still running. */
    servicePids: () => services.filter(c => c.exitCode === null && !c.signalCode).map(c => c.pid),
    async close() { await dispose(); writeFileSync(join(directory, 'observations.json'), JSON.stringify({ requests: simulated.requests, errors: simulated.errors, records: records(), owner: this.ownerRecords(), portfolio: portfolio ? { requests: portfolio.requests, errors: portfolio.errors, grants: portfolio.grants, state: this.portfolioState() } : null, browser: this.browserVersion ?? null }, null, 2)); },
  };
}
