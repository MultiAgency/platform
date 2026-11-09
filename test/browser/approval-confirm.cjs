/**
 * The confirm page for a vote on a held payout (/confirm/<token>, #48): it shows the terms the platform proved, and the
 * wallet signs exactly the vote's text, once, with no opening step: the app holds that text too. Offline: the gateway's
 * answers are fixtures.
 */
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const { runTask } = require('./fixtures/task.cjs');

const HOST = 'platform.test', OWNER = 'owner.near', TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const VOTE = { standard: 'nep413', payload: { message: `approve:a-1:ed25519:wallet:${'ab'.repeat(32)}`, recipient: 'outlayer.near', nonce: Buffer.alloc(32, 7).toString('base64') } };
const view = (over = {}) => ({ deployment: 'staging', organization: 'org_1', agent: 'payout', owner: OWNER, type: 'approval_vote',
  action: { type: 'approval_vote', approvalId: 'a-1', verdict: 'approve', correlationId: 'held-1' }, policy: null, summary: 'Approve',
  expiresAt: new Date(Date.now() + 300_000).toISOString(), signer: { account_id: OWNER, public_key: 'ed25519:fixture' }, intent: VOTE, state: 'open',
  payment: { correlationId: 'held-1', verdict: 'approve', terms: { recipient: 'payee.near', asset: USDC, amount: '2500000' } }, ...over });

async function confirmPage(browser, root, answer) {
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
        return { accountId: owner, publicKey: 'ed25519:fixture', signature: `signed:${payload.message.slice(0, 8)}` };
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
    if (p === `/confirm/v1/${TOKEN}` && req.method() === 'GET') return route.fulfill({ json: answer });
    if (p.startsWith(`/confirm/v1/${TOKEN}`)) {
      posts.push({ path: p, body: req.postDataJSON() });
      return route.fulfill({ json: { status: 'PENDING' } });
    }
    if (p.startsWith('/static/')) return route.fulfill({ path: root + p });
    if (p === `/confirm/${TOKEN}`) return route.fulfill({ path: root + '/confirm.html' });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await tab.goto(`http://${HOST}/confirm/${TOKEN}`);
  await tab.getByRole('heading', { name: 'Vote on a held payout', exact: true }).waitFor();
  return { context, tab, walletCalls, posts, errors, network };
}

/** The proven terms, exactly: the payee, the amount in USDC and in raw units with the asset id, and the payout. */
async function termsShown(tab) {
  await tab.getByText('payee.near', { exact: true }).waitFor();
  await tab.getByText('2.5 USDC', { exact: true }).waitFor();
  await tab.getByText(`2500000 raw units of ${USDC}`, { exact: true }).waitFor();
  await tab.getByText('A confidential transfer', { exact: true }).waitFor();
  await tab.getByText('held-1', { exact: true }).waitFor();
}

async function signsOnce(browser, root) {
  const fixture = await confirmPage(browser, root, view());
  try {
    const { tab, walletCalls, posts } = fixture;
    await termsShown(tab);
    await tab.getByText(/Your wallet asks once, for the action itself\./).waitFor();
    await tab.getByRole('button', { name: 'Sign and submit', exact: true }).click();
    await tab.getByText(/^Submitted\./).waitFor();
    assert.deepEqual(walletCalls.map(c => c.payload), [VOTE.payload], 'the wallet signs the vote\'s own text, once');
    assert.deepEqual(posts, [{ path: `/confirm/v1/${TOKEN}`, body: { signedData: { ...VOTE, public_key: 'ed25519:fixture', signature: 'signed:approve:' } } }]);
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.network, []);
    console.log('PASS a vote\'s link: the proven terms show exactly, and the wallet signs the vote once');
  } finally { await fixture.context.close(); }
}

async function rejecting(browser, root) {
  const fixture = await confirmPage(browser, root, view({ action: { type: 'approval_vote', approvalId: 'a-1', verdict: 'reject', correlationId: 'held-1' },
    payment: { correlationId: 'held-1', verdict: 'reject', terms: null } }));
  try {
    await fixture.tab.getByText(/Reject held payout held-1: this vote releases nothing\./).waitFor();
    assert.equal(await fixture.tab.getByText('payee.near').count(), 0);
    console.log('PASS a reject says it releases nothing');
  } finally { await fixture.context.close(); }
}

runTask([signsOnce, rejecting]);
