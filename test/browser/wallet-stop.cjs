/** A wallet owner's own stop page (/confirm/wallet/stop): the text it shows is what the wallet signs and what it sends. Offline. */
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const { runTask } = require('./fixtures/task.cjs');

const HOST = 'platform.test', OWNER = 'owner.near';

/** The gateway's canonical stop text (src/gateway/wallet-stop-text.ts): fixed key order, no whitespace. */
const canonical = ({ host, owner, agent, expiresAt }) => JSON.stringify({ type: 'multiagency.wallet-stop', version: 1, host, owner, agent, expiresAt });

async function stopPage(browser, root, { answers }) {
  const walletCalls = [], posts = [], errors = [], network = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.exposeBinding('fixtureWalletCall', async (_, method, payload) => { walletCalls.push({ method, payload }); });
  await context.addInitScript(({ host, owner }) => {
    if (location.host !== host) return;
    localStorage.setItem('selected-wallet:mainnet', 'fixture-wallet');
    const accounts = [{ accountId: owner, publicKey: 'ed25519:fixture' }];
    const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} },
      getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
      signMessage: async payload => {
        await window.fixtureWalletCall('message', { message: payload.message, recipient: payload.recipient, nonce: btoa(String.fromCharCode(...payload.nonce)) });
        return { accountId: owner, publicKey: 'ed25519:fixture', signature: 'offline-signature' };
      },
    };
    window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
  }, { host: HOST, owner: OWNER });
  const tab = await context.newPage(); tab.setDefaultTimeout(10_000);
  tab.on('pageerror', e => errors.push(e.message));
  await tab.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (url.host !== HOST) {
      if (p.endsWith('manifest.json')) return route.fulfill({ json: { wallets: [] } });
      network.push(req.url()); return route.abort();
    }
    if (p === '/confirm/v1/wallet-stop') {
      assert.equal(req.method(), 'POST');
      posts.push(req.postDataJSON());
      const answer = answers[posts.length - 1];
      assert.ok(answer, `unexpected stop number ${posts.length}`);
      return route.fulfill({ status: answer.status, json: answer.body });
    }
    if (p.startsWith('/static/')) return route.fulfill({ path: root + p });
    if (p.startsWith('/confirm/wallet/stop')) return route.fulfill({ path: root + '/confirm.html' });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return { context, tab, walletCalls, posts, errors, network };
}

/** Connects, reads the shown text, signs, and checks what was signed and sent is that exact canonical text. */
async function signAndCheck(fixture, path, expectedAgent) {
  const { tab, walletCalls, posts } = fixture;
  await tab.goto(`http://${HOST}${path}`);
  await tab.getByRole('heading', { name: 'Stop your agents', exact: true }).waitFor();
  assert.equal(posts.length, 0, 'opening the page sends nothing');
  // The owner's wallet session restores on load (a wallet already chosen in this browser), so no picker opens.
  await tab.getByText(`Connected as ${OWNER}`).waitFor();
  if (expectedAgent === '*' && path !== '/confirm/wallet/stop') await tab.getByRole('radio', { name: `Every agent of ${OWNER} on this host` }).check();
  const shown = await tab.getByRole('heading', { name: 'The exact text your wallet signs' }).locator('xpath=following-sibling::pre[1]').innerText();
  const parsed = JSON.parse(shown);
  assert.equal(shown, canonical(parsed), 'the shown text is canonical');
  assert.deepEqual([parsed.host, parsed.owner, parsed.agent], [HOST, OWNER, expectedAgent]);
  const expiresIn = Date.parse(parsed.expiresAt) - Date.now();
  assert.ok(expiresIn > 60_000 && expiresIn <= 3_600_000, `expires in ${expiresIn} ms: within the gateway's hour`);
  await tab.getByRole('button', { name: 'Sign and stop', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  assert.equal(walletCalls.length, 1);
  const signed = walletCalls[0].payload;
  assert.deepEqual([signed.message, signed.recipient], [shown, HOST], 'the wallet signs the shown text for this host');
  assert.equal(Buffer.from(signed.nonce, 'base64').length, 32);
  assert.deepEqual(posts[0], { message: shown, nonce: signed.nonce, publicKey: 'ed25519:fixture', signature: 'offline-signature' });
}

async function namedAgentRetry(browser, root) {
  const fixture = await stopPage(browser, root, { answers: [
    { status: 200, body: { at: '2026-11-08T12:00:00.000Z', agents: [{ agent: 'treasury', agentId: 'id-treasury', consentsEnded: 2, autopilot: 'not confirmed off' }] } },
    { status: 200, body: { at: '2026-11-08T12:00:00.000Z', agents: [{ agent: 'treasury', agentId: 'id-treasury', consentsEnded: 2, autopilot: 'off' }] } },
  ] });
  try {
    await signAndCheck(fixture, '/confirm/wallet/stop/treasury', 'treasury');
    const { tab, posts, walletCalls } = fixture;
    await tab.getByText('Consents ended; some autopilot not confirmed off').waitFor();
    const row = tab.getByRole('row', { name: /treasury/ });
    assert.match(await row.innerText(), /treasury\s+2\s+not confirmed off/);
    await tab.getByRole('button', { name: 'Send the same stop again', exact: true }).click();
    await tab.getByText('Stopped', { exact: true }).waitFor();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], posts[0], 'the retry sends the same signed stop');
    assert.equal(walletCalls.length, 1, 'and asks the wallet for nothing new');
    assert.equal(await tab.getByRole('button', { name: 'Send the same stop again' }).count(), 0);
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.network, []);
    console.log('PASS a named agent: the shown text is canonical, signed for this host and sent as signed; a retry resends it unchanged');
  } finally { await fixture.context.close(); }
}

async function everyAgentFromNamedLink(browser, root) {
  const fixture = await stopPage(browser, root, { answers: [
    { status: 200, body: { at: '2026-11-08T12:00:00.000Z', agents: [
      { agent: 'treasury', agentId: 'id-treasury', consentsEnded: 1, autopilot: 'off' },
      { agent: 'own-unborn', agentId: null, consentsEnded: 0, autopilot: 'not created' }] } },
  ] });
  try {
    await signAndCheck(fixture, '/confirm/wallet/stop/treasury', '*');
    await fixture.tab.getByText('Stopped', { exact: true }).waitFor();
    assert.equal(await fixture.tab.getByRole('row').count(), 3, 'a header and one row per agent');
    console.log('PASS every agent, chosen on a named link: the text says "*"');
  } finally { await fixture.context.close(); }
}

async function everyAgentRefused(browser, root) {
  const fixture = await stopPage(browser, root, { answers: [
    { status: 403, body: { error: 'ed25519:fixture is not a full-access key of owner.near.' } },
  ] });
  try {
    await signAndCheck(fixture, '/confirm/wallet/stop', '*');
    await fixture.tab.getByText('ed25519:fixture is not a full-access key of owner.near.').waitFor();
    assert.equal(await fixture.tab.getByRole('table').count(), 0, 'a refusal shows no result');
    assert.equal(await fixture.tab.getByRole('button', { name: 'Sign and stop' }).count(), 1, 'and the owner can sign again');
    console.log("PASS a refused stop shows the gateway's reason and no result");
  } finally { await fixture.context.close(); }
}

runTask([namedAgentRetry, everyAgentFromNamedLink, everyAgentRefused]);
