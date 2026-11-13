import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { environment } from './environment.mjs';
import { connectWallet, installWallet } from './wallet.mjs';
import { DAO, OWNER, PAYEE, PUBLIC_KEY, SECOND, listen } from './provider.mjs';
import { appCredential, stackControls } from './stack-controls.mjs';

// Written whole: a reader polling the file never sees it truncated.
const writeWhole = (path, text) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };

// A running isolated stack for app-owned recipes and filming: the same services, simulator and
// boundaries as the deterministic tests. Simulated provider, chain, signatures and settlement only.
// Controls are files in this directory, never HTTP endpoints on the application or simulator.
const args = process.argv.slice(2), values = flag => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : []);
const owner = values('--owner').at(-1) ?? OWNER, payees = values('--payee').length ? values('--payee') : [PAYEE];
const frontend = values('--frontend').at(-1), acceptDialogs = values('--accept-dialog');
// `--payables-release <release dir>`: serve that Payables build at /a/payout/ through the shared release server.
const payablesDist = values('--payables-release').at(-1);
// `--builder <account>`: an account on chain that is not yet an agreed payee; the owner adds it through the policy screen.
// `--payout-funding <raw USDC>`: the payout agent's starting balance (default 100 USDC); fund it later with `fundPayout`.
const builder = values('--builder').at(-1), payoutFunding = values('--payout-funding').at(-1);
// `--treasury`: also a Treasury agent, `portfolio`, owned by the owner (100 simulated USDC). The owner issues machine
// credentials with the `machineCredential` control; a server reads it at /machine/v1/a/portfolio.
const treasury = args.includes('--treasury');
// `--dao-treasury`: the Treasury agent `portfolio` belongs to the simulated DAO instead: apps reach it only under a DAO's
// consent, and its owner signatures are DAO votes the `daoVote` control passes. Use with `--app`, without `--treasury`.
const daoTreasury = args.includes('--dao-treasury');
if (treasury && daoTreasury) throw new Error('Use --treasury or --dao-treasury, not both');
// `--app <deployment>`: an app deployment's server reaches /apps/v1 with a service credential issued at startup, and may
// set up its Organizations' own hosted agents. The owner's signatures come from the `signOwner` control.
const app = values('--app').at(-1);
if (daoTreasury && !app) throw new Error('--dao-treasury needs --app: only an app reaches a DAO-owned agent');
if (frontend && payablesDist) throw new Error('Use --frontend or --payables-release, not both');
// `--on-chain-policy-edits`: freeze, unfreeze and a policy edit that changes a provider-enforced field come back as NEP-366, held for the
// platform's confirm page (see provider.mjs), for the Treasury agent and the Payables agent alike.
const onChainPolicyEdits = args.includes('--on-chain-policy-edits');
// `--market`: simulated listed agents `writer` (delivers), `refuser` (rejects), and `worker` (token-scoped assignments).
// `--market-webhook-url` sends signed worker events to a local HTTP loopback endpoint. Use with `--app`: a market agent is an app's.
// Controls `marketRegister` and `marketAdvance`. Worker credentials are kept in a private file, not state.json.
const marketSim = args.includes('--market');
if (marketSim && !app) throw new Error('--market needs --app: a market agent is set up by an app');
const marketWebhookUrl = values('--market-webhook-url').at(-1);
if (marketWebhookUrl && !marketSim) throw new Error('--market-webhook-url needs --market');
const directory = join(process.env.PROTO_E2E_ARTIFACTS, 'stack'), controls = join(directory, 'controls');
mkdirSync(controls, { recursive: true });
const stack = await environment(join(directory, 'environment'), { owner, payees, ...(builder && { accounts: [builder] }), ...(payoutFunding !== undefined && { payoutFunding: BigInt(payoutFunding) }),
  ...(frontend && { frontendDist: resolve(frontend) }), ...(treasury && { workspace: true, portfolioOwner: owner }), ...(daoTreasury && { daoPortfolio: true }),
  ...(app && { selfService: true, hostedAreas: ['payables'] }),
  ...(onChainPolicyEdits && { onChainPolicyEdits }), ...(marketSim && { market: true, marketWebhookUrl }),
  ...(payablesDist && { ownerApp: { product: 'payables', a: resolve(payablesDist), b: resolve(payablesDist) } }) });
const { simulated } = stack;
// One browser, two wallet contexts (owner, payee) behind the same wallet boundary as the tests. Attach over CDP.
let browser, cdp = null;
const wallets = {}, dialogs = [];
if (!args.includes('--no-browser')) {
  const probe = createServer(), port = await listen(probe); await new Promise(resolve => probe.close(resolve));
  browser = await chromium.launch({ headless: !args.includes('--headed'), executablePath: process.env.BROWSER_EXECUTABLE,
    args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
  cdp = `http://127.0.0.1:${port}`;
  for (const [role, account, url] of [['owner', owner, `${stack.dashboard}/a/payout/`], ['payee', builder ?? payees[0], stack.invoices]]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', ...(role === 'payee' && { viewport: { width: 390, height: 844 } }) });
    const wallet = await installWallet(context, stack, account);
    // Playwright dismisses dialogs nobody listens for. Each dialog is logged and left open for the attached
    // client or person to answer, unless it is a confirm whose exact text was passed with --accept-dialog.
    context.on('page', page => page.on('dialog', async dialog => {
      const accepted = dialog.type() === 'confirm' && acceptDialogs.includes(dialog.message());
      dialogs.push({ role, type: dialog.type(), message: dialog.message(), handled: accepted ? 'accepted' : 'left open', at: new Date().toISOString() });
      if (accepted) await dialog.accept();
    }));
    const page = await context.newPage();
    await page.goto(url);
    // The owner page starts signed in through the simulated wallet (the gateway session), ready for an attached client.
    const signedIn = role === 'owner';
    if (signedIn) await connectWallet(page, account);
    wallets[role] = { account, signedIn, page: page.url(), ...wallet };
  }
}
const commands = stackControls(stack, { owner, payees: [...payees, ...builder ? [builder] : []] });
// The app's service credential, readable only by this user: the token is never written to state.json.
const credentialFile = join(directory, 'app-credential');
if (app) writeFileSync(credentialFile, await appCredential(stack, app), { mode: 0o600 });
const workerCredentialsFile = join(directory, 'market-worker-credentials.json');
if (stack.market?.workerHandles.length) writeFileSync(workerCredentialsFile,
  JSON.stringify(Object.fromEntries(stack.market.workerHandles.map(handle => [handle, stack.market.credentials(handle)]))), { mode: 0o600 });
const state = () => ({
  dashboard: stack.dashboard, owner: `${stack.dashboard}/a/payout/`, payee: stack.invoices, ownerAccount: owner, payees,
  testPublicKey: PUBLIC_KEY, cdp, wallets: Object.fromEntries(Object.entries(wallets).map(([role, w]) => [role, { account: w.account, signedIn: w.signedIn, page: w.page, blockedRequests: w.unexpected.length }])),
  ownerFrontend: payablesDist ? { product: 'payables', release: resolve(payablesDist) } : frontend ? { dist: resolve(frontend) } : 'proto web',
  dialogs, parentAgent: simulated.id, createdAgents: simulated.created(), records: stack.records(), builder: builder ?? null,
  payoutPolicy: simulated.payoutPolicy(),
  // A DAO has no owner session, so a DAO-owned agent has no access page or machine credentials.
  treasury: stack.portfolio ? { agent: 'portfolio', agentId: stack.portfolio.id, owner: daoTreasury ? DAO : owner, signer: daoTreasury ? 'dao' : 'wallet',
    access: daoTreasury ? null : `${stack.dashboard}/a/portfolio/access`, machineBase: daoTreasury ? null : `${stack.dashboard}/machine/v1/a/portfolio` } : null,
  // The DAO's Group members: the council may file and vote, the member only vote.
  dao: daoTreasury ? { account: DAO, council: OWNER, member: SECOND } : null,
  // The simulated chain, as the stack's services read it (`NEAR_RPC_URL`): an app's server makes its own chain reads here.
  chain: { rpc: `${simulated.url}/chain` },
  market: stack.market ? { url: stack.market.url, agents: stack.market.handles,
    workerCredentialsFile: stack.market.workerHandles.length ? workerCredentialsFile : null } : null,
  app: app ? { deployment: app, base: stack.dashboard, credentialFile } : null,
  deposits: simulated.deposits.map(({ agent, correlation_id }) => ({ agent, correlation: correlation_id })),
  transfers: simulated.transfers.map(p => ({ agent: p.agent, correlation: p.correlation, approval: p.approval, status: p.status, recipient: p.body.recipient, amount: p.body.amount })),
  providerErrors: simulated.errors, simulated: ['provider', 'chain', 'wallet signatures', 'deposits', 'settlement', ...(stack.market ? ['agent market'] : [])],
  controls: { directory: controls, write: '<name>.json with {"command": one of ' + Object.keys(commands).join('|') + ', ...arguments}; the result appears as <name>.result.json', stop: 'create a file named stop' },
});
writeWhole(join(directory, 'state.json'), JSON.stringify(state(), null, 2));
console.log(`Isolated stack ready: ${join(directory, 'state.json')}`);
await new Promise(resolve => {
  // One pass at a time: a command may wait on the stack (signing in, issuing), and a file is answered once.
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const name of readdirSync(controls).filter(n => n.endsWith('.json') && !n.endsWith('.result.json'))) {
        const path = join(controls, name);
        let result;
        try {
          const { command, ...input } = JSON.parse(readFileSync(path, 'utf8'));
          if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command ${command}`);
          const value = await commands[command](input);
          result = { ok: true, ...(value !== undefined && { value }) };
        } catch (error) { result = { ok: false, error: String(error) }; }
        unlinkSync(path); writeWhole(path.replace(/\.json$/, '.result.json'), JSON.stringify(result));
      }
      writeWhole(join(directory, 'state.json'), JSON.stringify(state(), null, 2));
    } finally { running = false; }
    if (existsSync(join(directory, 'stop'))) { clearInterval(timer); resolve(); }
  }, 250);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { clearInterval(timer); resolve(); });
});
for (const [role, wallet] of Object.entries(wallets)) writeFileSync(join(directory, `${role}-blocked-requests.json`), JSON.stringify(wallet.unexpected, null, 2));
await browser?.close();
await stack.close();
console.log(`Stack stopped; observations in ${join(directory, 'environment', 'observations.json')}`);
