import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { environment } from './environment.mjs';
import { installWallet } from './wallet.mjs';
import { OWNER, PAYEE, PUBLIC_KEY, listen } from './provider.mjs';

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
// `--treasury`: also a Treasury agent, `portfolio`, owned by the payee account (100 simulated USDC). Its owner issues
// machine credentials at /a/portfolio/access; a server outside the browser reads it at /machine/v1/a/portfolio.
const treasury = args.includes('--treasury');
if (frontend && payablesDist) throw new Error('Use --frontend or --payables-release, not both');
const directory = join(process.env.PROTO_E2E_ARTIFACTS, 'stack'), controls = join(directory, 'controls');
mkdirSync(controls, { recursive: true });
const stack = await environment(join(directory, 'environment'), { owner, payees, ...(builder && { accounts: [builder] }), ...(payoutFunding !== undefined && { payoutFunding: BigInt(payoutFunding) }),
  ...(frontend && { frontendDist: resolve(frontend) }), ...(treasury && { workspace: true }),
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
    let signedIn = false;
    if (role === 'owner') {
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
      for (let i = 0; i < 100 && !signedIn; i++) {
        // The app reloads itself once the session is set; a read during that navigation counts as "not yet".
        signedIn = await page.evaluate(async () => (await (await fetch('/gw/me')).json()).viewer?.account ?? null).catch(() => null) === account;
        if (!signedIn) await new Promise(r => setTimeout(r, 100));
      }
      if (!signedIn) throw new Error(`The owner page did not sign in as ${account}`);
    }
    wallets[role] = { account, signedIn, page: page.url(), ...wallet };
  }
}
const commands = {
  fund: ({ agent, amount }) => simulated.fund(agent, amount),
  settle: ({ correlation }) => simulated.settle(correlation),
  dropTransferResponse: () => simulated.dropTransferResponse(),
  fundPayout: ({ amount }) => simulated.fundPayout(amount),
  dropSignatureResponse: () => simulated.dropSignatureResponse(),
  revealOwnerOutcome: () => simulated.revealOwnerOutcome(),
  setUnavailable: ({ value }) => simulated.setUnavailable(value === true),
};
const state = () => ({
  dashboard: stack.dashboard, owner: `${stack.dashboard}/a/payout/`, payee: stack.invoices, ownerAccount: owner, payees,
  testPublicKey: PUBLIC_KEY, cdp, wallets: Object.fromEntries(Object.entries(wallets).map(([role, w]) => [role, { account: w.account, signedIn: w.signedIn, page: w.page, blockedRequests: w.unexpected.length }])),
  ownerFrontend: payablesDist ? { product: 'payables', release: resolve(payablesDist) } : frontend ? { dist: resolve(frontend) } : 'proto web',
  dialogs, parentAgent: simulated.id, createdAgents: simulated.created(), records: stack.records(), builder: builder ?? null,
  payoutPolicy: simulated.payoutPolicy(),
  treasury: stack.portfolio ? { agent: 'portfolio', agentId: stack.portfolio.id, owner: PAYEE, access: `${stack.dashboard}/a/portfolio/access`,
    machineBase: `${stack.dashboard}/machine/v1/a/portfolio` } : null,
  deposits: simulated.deposits.map(({ agent, correlation_id }) => ({ agent, correlation: correlation_id })),
  transfers: simulated.transfers.map(p => ({ agent: p.agent, correlation: p.correlation, approval: p.approval, status: p.status, recipient: p.body.recipient, amount: p.body.amount })),
  providerErrors: simulated.errors, simulated: ['provider', 'chain', 'wallet signatures', 'deposits', 'settlement'],
  controls: { directory: controls, write: '<name>.json with {"command": one of ' + Object.keys(commands).join('|') + ', ...arguments}; the result appears as <name>.result.json', stop: 'create a file named stop' },
});
writeFileSync(join(directory, 'state.json'), JSON.stringify(state(), null, 2));
console.log(`Isolated stack ready: ${join(directory, 'state.json')}`);
await new Promise(resolve => {
  const timer = setInterval(() => {
    for (const name of readdirSync(controls).filter(n => n.endsWith('.json') && !n.endsWith('.result.json'))) {
      const path = join(controls, name);
      let result;
      try { const { command, ...input } = JSON.parse(readFileSync(path, 'utf8')); if (!commands[command]) throw new Error(`Unknown command ${command}`); commands[command](input); result = { ok: true }; }
      catch (error) { result = { ok: false, error: String(error) }; }
      unlinkSync(path); writeFileSync(path.replace(/\.json$/, '.result.json'), JSON.stringify(result));
    }
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state(), null, 2));
    if (existsSync(join(directory, 'stop'))) { clearInterval(timer); resolve(); }
  }, 250);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { clearInterval(timer); resolve(); });
});
for (const [role, wallet] of Object.entries(wallets)) writeFileSync(join(directory, `${role}-blocked-requests.json`), JSON.stringify(wallet.unexpected, null, 2));
await browser?.close();
await stack.close();
console.log(`Stack stopped; observations in ${join(directory, 'environment', 'observations.json')}`);
