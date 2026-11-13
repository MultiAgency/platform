import { readFileSync } from 'node:fs';
import { sign, signDelegate, PUBLIC_KEY } from './provider.mjs';

/**
 * Signs `account` in to the gateway from a page on its origin and waits until the session names it: the page asks for
 * the gateway's challenge, the simulated wallet signs it, and the page opens the session, as any owner frontend does.
 * The platform serves no owner page of its own, so nothing here depends on one; a frontend already loaded on the page
 * reads the session on its next load.
 */
export async function connectWallet(page, account) {
  const viewer = await page.evaluate(async account => {
    const challenge = await (await fetch('/gw/challenge')).json();
    const signed = await window.__localSign(challenge);
    const session = await fetch('/gw/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, callbackUrls: [] }) });
    if (!session.ok) throw new Error(`Gateway sign-in refused: ${session.status} ${await session.text()}`);
    return (await (await fetch('/gw/me')).json()).viewer?.account ?? null;
  }, account);
  if (viewer !== account) throw new Error(`The gateway session names ${viewer}, not ${account}`);
}

/**
 * The signed-in wallet owner's machine access on a Treasury agent, through the gateway's own routes from the page:
 * `POST` issues (`{ label, scopes }`), `GET` lists, `DELETE` with a credential's id revokes.
 */
export const machineAccess = (page, agent) => (method, id = '', body) => page.evaluate(async ({ agent, method, id, body }) => {
  const response = await fetch(`/gw/machine-credentials/${agent}${id && `/${id}`}`,
    { method, ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}, { agent, method, id, body });

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
