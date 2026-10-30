import { readFileSync } from 'node:fs';
import { sign, signDelegate, PUBLIC_KEY } from './provider.mjs';

/**
 * Connects the simulated wallet on an owner page and waits until the gateway session names `account`. Every owner
 * frontend reloads itself once the session is set, so the session is read only after that reload has loaded: a read
 * during the navigation is destroyed with the page (seen under load in the release candidate, 2026-10-30). A page whose
 * near-connect asks which wallet to use (an app's default `connect()`) is answered with the local test wallet.
 */
export async function connectWallet(page, account) {
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  const chooser = page.getByText('Local test wallet', { exact: true });
  await Promise.race([reloaded, chooser.waitFor({ timeout: 15_000 }).then(() => chooser.click()).catch(() => {})]);
  await reloaded;
  const viewer = await page.evaluate(async () => (await (await fetch('/gw/me')).json()).viewer?.account ?? null);
  if (viewer !== account) throw new Error(`The owner page signed in as ${viewer}, not ${account}`);
}

/** External wallet boundary only: actual app routes and RPC responses are never intercepted. */
export async function browserContext(browser, env, account, options = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', ...options });
  return installWallet(context, env, account);
}

export async function installWallet(context, env, account) {
  const unexpected = [], applicationRequests = [], signatures = [];
  context.on('request', request => {
    if ([env.dashboard, env.invoices].includes(new URL(request.url()).origin)) applicationRequests.push({ method: request.method(), url: request.url() });
  });
  const origins = new Set([env.dashboard, env.invoices]);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (origins.has(url.origin)) return route.continue();
    if (url.hostname === 'cdn.jsdelivr.net' && url.pathname === '/npm/@fastnear/near-connect@0.14.1/+esm')
      return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../../node_modules/@fastnear/near-connect/cdn/hot-connect.es.js', import.meta.url), 'utf8') });
    if (['cdn.jsdelivr.net', 'raw.githubusercontent.com'].includes(url.hostname) && url.pathname.endsWith('/manifest.json'))
      return route.fulfill({ json: { version: '1.0.0', wallets: [] } });
    unexpected.push(route.request().url()); await route.abort();
  });
  await context.routeWebSocket('**/*', socket => { unexpected.push(socket.url()); socket.close(); });
  await context.exposeFunction('__localSign', payload => { signatures.push({ account, ...payload }); return sign(account, payload); });
  await context.exposeFunction('__localSignDelegate', payload => { signatures.push({ account, delegate: payload }); return signDelegate(account, payload); });
  await context.addInitScript(({ account, publicKey, origins }) => {
    if (!origins.includes(location.origin)) return;
    const accounts = [{ accountId: account, publicKey }];
    const wallet = { manifest: { id: 'local-test-wallet', name: 'Local test wallet', type: 'injected',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', features: { signMessage: true, signDelegateActions: true } },
      signIn: async () => accounts, getAccounts: async () => accounts, signOut: async () => {},
      signMessage: payload => window.__localSign({ ...payload, nonce: btoa(String.fromCharCode(...new Uint8Array(payload.nonce))) }),
      signAndSendTransaction: async () => { throw new Error('Chain submission is not implemented by this test wallet'); },
      signDelegateActions: async ({ delegateActions }) => ({ signedDelegateActions: await Promise.all(delegateActions.map(action => window.__localSignDelegate(action))) }),
    };
    // Exercise near-connect's actual injected-wallet interface; no application module replacement.
    window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
    for (const prefix of ['', 'member:']) localStorage.setItem(`${prefix}selected-wallet:mainnet`, 'local-test-wallet');
  }, { account, publicKey: PUBLIC_KEY, origins: [...origins] });
  return { context, unexpected, applicationRequests, signatures };
}
