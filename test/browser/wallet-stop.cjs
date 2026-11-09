/**
 * A wallet owner's own stop page (/confirm/wallet/stop): the text it shows is what the wallet signs and what it sends; asked
 * to freeze too, the wallet signs exactly the provider's intent the stop handed back, and the page sends that. Offline.
 */
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const { runTask } = require('./fixtures/task.cjs');

const HOST = 'platform.test', OWNER = 'owner.near';

/** The gateway's canonical stop text (src/gateway/wallet-stop-text.ts): fixed key order, no whitespace. */
const canonical = ({ host, owner, agent, expiresAt, freeze }) => JSON.stringify({ type: 'multiagency.wallet-stop', version: 1, host, owner, agent, expiresAt, ...(freeze && { freeze: true }) });
/** The provider's freeze intent as the stop hands it back (NEP-366, calling outlayer.near freeze_wallet). */
const FREEZE_INTENT = { standard: 'nep366', payload: { receiverId: 'outlayer.near',
  actions: [{ type: 'FunctionCall', params: { methodName: 'freeze_wallet', args: { wallet_pubkey: 'w-treasury' }, gas: '30000000000000', deposit: '0' } }] } };
const SIGNER = { type: 'near', account_id: OWNER, public_key: 'ed25519:provider-owner-key' };

async function stopPage(browser, root, { answers, clock = false, preselected = true, delegates = false, follow = {} }) {
  const walletCalls = [], posts = [], errors = [], network = [], follows = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  if (clock) await context.clock.install();
  await context.exposeBinding('fixtureWalletCall', async (_, method, payload) => { walletCalls.push({ method, payload }); });
  await context.addInitScript(({ host, owner, preselected, delegates }) => {
    if (location.host !== host) return;
    // Chosen before in this browser, so the stop page's own wallet session restores on load.
    if (preselected) localStorage.setItem('stop:selected-wallet:mainnet', 'fixture-wallet');
    const accounts = [{ accountId: owner, publicKey: 'ed25519:fixture' }];
    // A message-only wallet by default: the stop needs nothing more. A freeze (NEP-366) needs delegate signing.
    const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, ...(delegates && { signDelegateActions: true }) }, permissions: {} },
      getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
      signMessage: async payload => {
        await window.fixtureWalletCall('message', { message: payload.message, recipient: payload.recipient, nonce: btoa(String.fromCharCode(...payload.nonce)) });
        return { accountId: owner, publicKey: 'ed25519:fixture', signature: 'offline-signature' };
      },
      ...(delegates && { signDelegateActions: async payload => { await window.fixtureWalletCall('delegate', payload); return { signedDelegateActions: ['offline-delegate'] }; } }),
    };
    window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
  }, { host: HOST, owner: OWNER, preselected, delegates });
  const tab = await context.newPage(); tab.setDefaultTimeout(10_000);
  tab.on('pageerror', e => errors.push(e.message));
  await tab.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (url.host !== HOST) {
      if (p.endsWith('manifest.json')) return route.fulfill({ json: { wallets: [] } });
      network.push(req.url()); return route.abort();
    }
    if (p === '/confirm/v1/wallet-stop/freeze' || p === '/confirm/v1/wallet-stop/freeze-status') {
      assert.equal(req.method(), 'POST');
      follows.push({ path: p, body: req.postDataJSON() });
      const answer = follow[p];
      assert.ok(answer, `unexpected ${p}`);
      return route.fulfill({ status: answer.status, json: answer.body });
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
  return { context, tab, walletCalls, posts, errors, network, follows };
}

/** Connects, reads the shown text, signs, and checks what was signed and sent is that exact canonical text. */
async function signAndCheck(fixture, path, expectedAgent, { freeze = false } = {}) {
  const { tab, walletCalls, posts } = fixture;
  if (path) await tab.goto(`http://${HOST}${path}`);
  await tab.getByRole('heading', { name: 'Stop your agents', exact: true }).waitFor();
  assert.equal(posts.length, 0, 'opening the page sends nothing');
  // The owner's wallet session restores on load (a wallet already chosen in this browser), so no picker opens.
  await tab.getByText(`Connected as ${OWNER}`).waitFor();
  if (expectedAgent === '*' && path !== '/confirm/wallet/stop') await tab.getByRole('radio', { name: `Every agent of ${OWNER} on this host` }).click();
  if (freeze) await tab.getByRole('checkbox', { name: /Freeze them too/ }).check();
  const shown = await tab.getByRole('heading', { name: 'The exact text your wallet signs' }).locator('xpath=following-sibling::pre[1]').innerText();
  const parsed = JSON.parse(shown);
  assert.equal(shown, canonical(parsed), 'the shown text is canonical');
  assert.deepEqual([parsed.host, parsed.owner, parsed.agent, parsed.freeze], [HOST, OWNER, expectedAgent, freeze ? true : undefined]);
  const expiresIn = Date.parse(parsed.expiresAt) - await tab.evaluate(() => Date.now());
  assert.ok(expiresIn > 60_000 && expiresIn <= 3_600_000, `expires in ${expiresIn} ms: within the gateway's hour`);
  await tab.getByRole('button', { name: freeze ? 'Sign, stop and prepare the freeze' : 'Sign and stop', exact: true }).click();
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

/** A page left open past most of the text's 10 minutes still signs a text with time left, never a stale one. */
async function openLongBeforeSigning(browser, root) {
  const fixture = await stopPage(browser, root, { clock: true, answers: [
    { status: 200, body: { at: '2026-11-08T12:00:00.000Z', agents: [{ agent: 'treasury', agentId: 'id-treasury', consentsEnded: 1, autopilot: 'off' }] } },
  ] });
  try {
    const { tab } = fixture;
    await tab.goto(`http://${HOST}/confirm/wallet/stop/treasury`);
    await tab.getByText(`Connected as ${OWNER}`).waitFor();
    const text = () => tab.getByRole('heading', { name: 'The exact text your wallet signs' }).locator('xpath=following-sibling::pre[1]').innerText();
    const first = JSON.parse(await text()).expiresAt;
    await tab.clock.runFor('09:30');
    await expect.poll(async () => JSON.parse(await text()).expiresAt, { message: 'the shown text is renewed before it runs out' }).not.toBe(first);
    await signAndCheck(fixture, null, 'treasury');
    await tab.getByText('Stopped', { exact: true }).waitFor();
    console.log('PASS a page left open renews its text before it expires, and signs the renewed text in one click');
  } finally { await fixture.context.close(); }
}

/** A first visit: the owner picks a wallet that signs messages only, the one thing a stop needs. */
async function firstVisitMessageOnlyWallet(browser, root) {
  const fixture = await stopPage(browser, root, { preselected: false, answers: [
    { status: 200, body: { at: '2026-11-08T12:00:00.000Z', agents: [{ agent: 'treasury', agentId: 'id-treasury', consentsEnded: 1, autopilot: 'off' }] } },
  ] });
  try {
    const { tab } = fixture;
    await tab.goto(`http://${HOST}/confirm/wallet/stop/treasury`);
    await tab.getByRole('button', { name: "Connect the owner's wallet", exact: true }).click();
    await tab.getByText('Offline wallet', { exact: true }).click();
    await signAndCheck(fixture, null, 'treasury');
    await tab.getByText('Stopped', { exact: true }).waitFor();
    console.log('PASS a first visit lists a wallet that signs messages only, and it signs the stop');
  } finally { await fixture.context.close(); }
}

const stoppedWithFreeze = freeze => ({ status: 200, body: { at: '2026-11-08T12:00:00.000Z', agents: [
  { agent: 'treasury', agentId: 'id-treasury', consentsEnded: 1, autopilot: 'off', freeze }] } });
const SIGNABLE = { state: 'sign', correlationId: 'c-freeze', expiresAt: '2099-01-01T00:00:00.000Z', intent: FREEZE_INTENT, signer: SIGNER };

/** Asked to freeze too: the stop hands back the provider's intent, the wallet signs exactly it, and the page sends it and follows it. */
async function stopAndFreeze(browser, root) {
  const fixture = await stopPage(browser, root, { delegates: true, answers: [stoppedWithFreeze(SIGNABLE)], follow: {
    '/confirm/v1/wallet-stop/freeze': { status: 200, body: { correlationId: 'c-freeze', submitted: { status: 'PENDING', failureCode: null } } },
    '/confirm/v1/wallet-stop/freeze-status': { status: 200, body: { correlationId: 'c-freeze', status: { stage: 'submitted', status: 'SUCCESS', failureCode: null, phase: 'settled' } } },
  } });
  try {
    await signAndCheck(fixture, '/confirm/wallet/stop/treasury', 'treasury', { freeze: true });
    const { tab, walletCalls, posts, follows } = fixture;
    assert.equal(follows.length, 0, 'nothing is submitted before the owner signs the freeze');
    await tab.getByRole('button', { name: 'Sign the freeze of treasury', exact: true }).click();
    await tab.getByText('Freeze SUCCESS', { exact: true }).waitFor();
    assert.equal(walletCalls.length, 2);
    assert.deepEqual(walletCalls[1], { method: 'delegate', payload: { delegateActions: [FREEZE_INTENT.payload], network: 'mainnet' } }, "the wallet signs exactly the provider's intent");
    assert.deepEqual(follows, [
      { path: '/confirm/v1/wallet-stop/freeze', body: { stop: posts[0], agent: 'treasury', signedData: { ...FREEZE_INTENT, signed_delegate: 'offline-delegate' } } },
      { path: '/confirm/v1/wallet-stop/freeze-status', body: { stop: posts[0], agent: 'treasury' } },
    ], 'the signed stop is the proof sent with the freeze and its status read');
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.network, []);
    console.log("PASS stop and freeze: the text says freeze, the wallet signs exactly the provider's intent, the page submits it and reads its status");
  } finally { await fixture.context.close(); }
}

/** A message-only wallet signs the stop but can't sign a NEP-366 freeze: the page says so, sends nothing, and offers another wallet. */
async function freezeNeedsDelegateWallet(browser, root) {
  const fixture = await stopPage(browser, root, { answers: [stoppedWithFreeze(SIGNABLE)] });
  try {
    await signAndCheck(fixture, '/confirm/wallet/stop/treasury', 'treasury', { freeze: true });
    const { tab, follows } = fixture;
    await tab.getByRole('button', { name: 'Sign the freeze of treasury', exact: true }).click();
    await tab.getByText(/doesn't sign delegate actions/).waitFor();
    assert.equal(follows.length, 0);
    assert.equal(fixture.walletCalls.length, 1, 'the wallet was asked for nothing it cannot sign');
    await tab.getByRole('button', { name: 'Connect another wallet', exact: true }).waitFor();
    console.log("PASS a message-only wallet can't sign the freeze: nothing is sent, and another wallet is offered");
  } finally { await fixture.context.close(); }
}

/** A freeze the stop couldn't prepare says why, and the same signed stop is offered again. */
async function freezeNotPrepared(browser, root) {
  const fixture = await stopPage(browser, root, { delegates: true, answers: [
    stoppedWithFreeze({ state: 'not prepared', reason: "The agent couldn't prepare the freeze: it didn't answer. Send the same stop again." }),
    stoppedWithFreeze(SIGNABLE),
  ] });
  try {
    await signAndCheck(fixture, '/confirm/wallet/stop/treasury', 'treasury', { freeze: true });
    const { tab, posts } = fixture;
    await tab.getByText(/Freeze not prepared: The agent couldn't prepare the freeze/).waitFor();
    await tab.getByRole('button', { name: 'Send the same stop again', exact: true }).click();
    await tab.getByRole('button', { name: 'Sign the freeze of treasury', exact: true }).waitFor();
    assert.deepEqual(posts[1], posts[0]);
    console.log("PASS a freeze not prepared says why, and resending the same stop prepares it");
  } finally { await fixture.context.close(); }
}

runTask([namedAgentRetry, everyAgentFromNamedLink, everyAgentRefused, openLongBeforeSigning, firstVisitMessageOnlyWallet, stopAndFreeze, freezeNeedsDelegateWallet, freezeNotPrepared]);
