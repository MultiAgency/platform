import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must identify the exact offline test input`);
  return value;
};
const APP_ROOT = required('CROSSREPO_APP_ROOT');
const PLATFORM_ROOT = required('CROSSREPO_PLATFORM_ROOT');
const APP_HEAD = required('CROSSREPO_APP_HEAD');
const SDK_SHA = required('CROSSREPO_SDK_SHA');
const OWNER = 'owner.near';
const ORG = 'org_1';
const AGENT = 'portfolio';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const WNEAR = 'nep141:wrap.near';

const value = result => {
  if (!result?.ok) throw new Error(`SDK call failed: ${JSON.stringify(result)}`);
  return result.value;
};
const assertNotFinal = (answer, label) => {
  const result = answer?.result;
  assert(result && typeof result.ok === 'boolean', `${label}: missing typed app result`);
  if (!result.ok) assert.equal(result.kind, 'unknown', `${label}: expected an unresolved, poll-only reply`);
  else {
    assert.notEqual(result.value.state, 'completed', `${label}: final state without payout evidence`);
    assert.notEqual(result.value.isPayoutStatusFinal, true, `${label}: final payout without provider evidence`);
  }
};
const assertLoopback = input => {
  const url = new URL(input);
  assert(['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname), `Refusing non-loopback URL ${url.origin}`);
};
const packedFiles = root => {
  const found = [];
  const scan = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) scan(join(directory, entry.name), `${name}/`);
      else if (entry.isFile()) found.push(name);
      else throw new Error(`Unexpected package entry: ${name}`);
    }
  };
  scan(root);
  return found.sort();
};
/** The app's installed alias must be exactly the vendored archive's members, byte for byte. */
function verifyInstalledSdk(tarball) {
  const temporary = mkdtempSync('/private/tmp/crossrepo-sdk-compare-');
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
    const archive = join(temporary, 'package');
    const installed = realpathSync(join(APP_ROOT, 'node_modules', '@multiagency', 'treasury-app-sdk'));
    const expected = packedFiles(archive);
    // pnpm writes this executable shim when linking the package; it is not an archive member.
    const installedFiles = packedFiles(installed).filter(file => file !== 'node_modules/.bin/multiagency-release-server');
    assert.deepEqual(installedFiles, expected, 'installed SDK payload paths differ from the vendored archive');
    for (const file of expected) assert(readFileSync(join(installed, file)).equals(readFileSync(join(archive, file))),
      `installed SDK bytes differ from the vendored archive: ${file}`);
    return expected.length;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
const freePort = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};

/** Trust only this one generated stack CA. The app process uses NODE_EXTRA_CA_CERTS separately. */
const stackFetch = cert => (url, options = {}) => new Promise((resolve, reject) => {
  const uri = new URL(url);
  assertLoopback(uri);
  const req = httpsRequest(uri, { method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), ca: cert }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.on('error', reject);
  req.end(options.body);
});

/** Starts the signed Treasury app; its credential is passed through the environment, never printed. */
async function appServer({ stackDirectory, stackState, appDirectory, port: requestedPort }) {
  const port = requestedPort ?? await freePort();
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const state = join(appDirectory, 'state');
  const certFile = join(stackDirectory, 'environment', 'localhost.crt');
  assert(existsSync(certFile), 'the stack must provide its own certificate');
  const offlineFixture = join(PLATFORM_ROOT, 'test', 'fixtures', 'offline-network.cjs');
  const exitWithParent = join(PLATFORM_ROOT, 'test', 'e2e', 'exit-with-parent.cjs');
  assert(existsSync(offlineFixture) && existsSync(exitWithParent), 'the offline network and lifetime guards must exist');
  const env = {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require ${JSON.stringify(offlineFixture)} --require ${JSON.stringify(exitWithParent)}`,
    NODE_EXTRA_CA_CERTS: certFile,
    NEAR_RPC_URL: stackState.chain.rpc,
    APP_HOST: host,
    APP_STATE: state,
    APP_WEB_DIST: join(APP_ROOT, 'web', 'dist'),
    PLATFORM_URL: stackState.dashboard,
    TREASURY_APP_CREDENTIAL: readFileSync(stackState.app.credentialFile, 'utf8').trim(),
    SESSION_SECRET: 'offline-crossrepo-session-secret-at-least-32-characters',
    PORT: String(port),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'app', 'main.ts')], {
    cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const logFile = join(appDirectory, 'app-server.log');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    output += chunk;
    writeFileSync(logFile, output);
  });
  for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (child.exitCode !== null) throw new Error(`Treasury app exited on startup: ${output.slice(-1200)}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.status === 200) return { child, origin, host, state, output: () => output };
    } catch { /* Still starting. */ }
    await delay(100);
  }
  child.kill('SIGTERM');
  throw new Error(`Treasury app did not become healthy: ${output.slice(-1200)}`);
}

async function stopApp(child) {
  if (child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([ended, delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await ended;
}

/** Actual app HTTP, with the app's own signed session cookie. */
function appHttp(origin) {
  let cookie = '';
  return {
    setCookie(value) { cookie = value; },
    async call(path, { method = 'GET', body, authenticated = true } = {}) {
      const options = { method, headers: { ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...(authenticated && cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const response = await fetch(new URL(path, origin), options);
      const json = await response.json().catch(() => null);
      return { status: response.status, body: json, headers: response.headers };
    },
  };
}

const orderTerms = requestId => ({ requestId, base_asset: WNEAR, quote_asset: USDC, side: 'buy',
  quantity: '1000000000000000000000000', price: '2.37', confidential: true,
  deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });

/**
 * Real Treasury app server + SDK client against the local platform gateway. The platform/provider
 * simulator controls are supplied by the parent harness. No external address is admitted.
 */
export async function runAppJourney({ stackDirectory, stackState, control, transcript = [] }) {
  assertLoopback(stackState.dashboard);
  assertLoopback(stackState.chain.rpc);
  assert.match(APP_HEAD, /^[a-f0-9]{40}$/);
  assert.match(SDK_SHA, /^[a-f0-9]{64}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).trim(), APP_HEAD);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: APP_ROOT, encoding: 'utf8' }).trim(), '',
    'Treasury source checkout must be clean and exactly the recorded commit');
  const tarball = join(APP_ROOT, 'vendor', 'multiagency-sdk-0.5.8.tgz');
  assert.equal(createHash('sha256').update(readFileSync(tarball)).digest('hex'), SDK_SHA);
  const installedFiles = verifyInstalledSdk(tarball);
  transcript.push(`Vendored SDK SHA-256 matched ${installedFiles} installed package files exactly`);
  const { appClient, consentMessage, limitOrderText } = await import(pathToFileURL(join(APP_ROOT, 'node_modules', '@multiagency', 'treasury-app-sdk', 'dist', 'contract', 'index.js')).href);
  const cert = readFileSync(join(stackDirectory, 'environment', 'localhost.crt'));
  const credential = readFileSync(stackState.app.credentialFile, 'utf8').trim();
  const platform = appClient({ base: stackState.dashboard, credential, fetch: stackFetch(cert) });
  const host = new URL(stackState.dashboard).host;
  const signed = async (message, recipient, nonce = randomBytes(32).toString('base64')) => {
    const result = await control('signOwner', { message, recipient, nonce });
    assert.equal(result.ok, true, `owner signing failed: ${result.error ?? ''}`);
    return { message, nonce, publicKey: result.value.publicKey, signature: result.value.signature };
  };
  const ownerSigned = async (message, recipient = host) => signed(message, recipient);
  const identity = value(await platform.identity(AGENT));
  assert.equal(identity.agentId, stackState.treasury.agentId);
  assert.equal(identity.owner, OWNER);
  const ownerConsent = consentMessage({ host, deployment: stackState.app.deployment, organization: ORG,
    owner: OWNER, agent: AGENT, agentId: identity.agentId, scopes: ['owner', 'read'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  value(await platform.consents.submit(await ownerSigned(ownerConsent)));
  const agent = platform.agent(ORG, AGENT);
  const overview = value(await agent.call('overview'));
  const prepared = value(await agent.call('owner/prepare', { action: { type: 'policy_update',
    expectedPolicy: { revision: overview.policy.revision, digest: overview.digest },
    changes: { limit_order: { enabled: true, max_deviation_bps: 300 } } }, signer: 'wallet' }));
  assert(prepared.intent?.payload, 'offline policy update needs an owner-signed intent');
  assert(!value(await agent.call('overview')).policy.policy.actions.includes('limit_order'),
    'preparing an order policy must not enable it before the owner signs');
  const policySignature = await control('signOwner', prepared.intent.payload);
  assert.equal(policySignature.ok, true);
  value(await agent.call('owner/submit', { correlationId: prepared.correlationId,
    signedData: { ...prepared.intent, public_key: policySignature.value.publicKey,
      signature: policySignature.value.signature } }));
  for (let tries = 0; tries < 30; tries++) {
    const state = value(await agent.call('owner/status', { correlationId: prepared.correlationId }));
    if (state.status === 'SUCCESS') break;
    if (tries === 29) throw new Error(`Signed order policy did not apply: ${JSON.stringify(state)}`);
    await delay(100);
  }
  const updated = value(await agent.call('overview'));
  assert(updated.policy.policy.actions.includes('limit_order'));
  assert.equal(updated.policy.policy.limit_order.max_deviation_bps, 300);
  transcript.push('Owner-signed app policy update enabled limit_order with max_deviation_bps 300');
  const authorized = value(await control('authorizeStrategy'));
  assert.equal(typeof authorized.digest, 'string');
  transcript.push('Platform owner signed a strategy-bound Treasury grant before order placement');

  const appDirectory = join(stackDirectory, 'app-consumer');
  mkdirSync(appDirectory, { recursive: true });
  let server = await appServer({ stackDirectory, stackState, appDirectory });
  let http = appHttp(server.origin);
  const restart = async () => {
    await stopApp(server.child);
    server = await appServer({ stackDirectory, stackState, appDirectory, port: Number(new URL(server.origin).port) });
    const priorCookie = cookie;
    http = appHttp(server.origin);
    http.setCookie(priorCookie);
    transcript.push('Treasury app restarted with retained private state');
  };
  let cookie = '';
  try {
    const challenge = await http.call('/app/challenge', { authenticated: false });
    assert.equal(challenge.status, 200);
    const signedIn = await signed(challenge.body.message, challenge.body.recipient, challenge.body.nonce);
    const session = await http.call('/app/session', { method: 'POST', body: { accountId: OWNER,
      publicKey: signedIn.publicKey, signature: signedIn.signature, nonce: signedIn.nonce }, authenticated: false });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    cookie = session.headers.get('set-cookie').split(';')[0];
    http.setCookie(cookie);
    transcript.push('Owner signed in to actual Treasury app using the simulated chain key');

    const treasuryOnly = await http.call('/app/connect/prepare', { method: 'POST', body: {
      organization: ORG, agent: AGENT } });
    assert.equal(treasuryOnly.status, 200, JSON.stringify(treasuryOnly.body));
    assert.deepEqual(treasuryOnly.body.scopes, ['read', 'treasury']);
    const treasurySignature = await signed(treasuryOnly.body.message, treasuryOnly.body.recipient, treasuryOnly.body.nonce);
    const treasuryConnected = await http.call('/app/connect', { method: 'POST', body: {
      nonce: treasurySignature.nonce, publicKey: treasurySignature.publicKey, signature: treasurySignature.signature } });
    assert.equal(treasuryConnected.status, 201, JSON.stringify(treasuryConnected.body));
    const beforeOrderConsent = await http.call(`/app/orders/access?organization=${ORG}&agent=${AGENT}`);
    assert.equal(beforeOrderConsent.status, 200, JSON.stringify(beforeOrderConsent.body));
    assert.equal(beforeOrderConsent.body.capable, true);
    assert.equal(beforeOrderConsent.body.consented, false);
    const deniedQuote = await http.call('/app/orders/quote', { method: 'POST', body: {
      organization: ORG, agent: AGENT, base_asset: WNEAR, quote_asset: USDC, side: 'buy',
      quantity: '1000000000000000000000000', price: '2.37', confidential: true,
      deadline: new Date(Date.now() + 60 * 60_000).toISOString() } });
    assert.equal(deniedQuote.status, 403, JSON.stringify(deniedQuote.body));
    assert.match(deniedQuote.body.error, /treasury-orders/);
    transcript.push('Treasury-only consent refused order quote despite live capability and owner policy');

    const preparedConsent = await http.call('/app/connect/prepare', { method: 'POST', body: {
      organization: ORG, agent: AGENT, orders: true } });
    assert.equal(preparedConsent.status, 200, JSON.stringify(preparedConsent.body));
    assert.deepEqual(preparedConsent.body.scopes, ['read', 'treasury', 'treasury-orders']);
    assert(!preparedConsent.body.scopes.includes('treasury-execute'));
    const consentSignature = await signed(preparedConsent.body.message, preparedConsent.body.recipient, preparedConsent.body.nonce);
    const submittedConsent = await http.call('/app/connect', { method: 'POST', body: {
      nonce: consentSignature.nonce, publicKey: consentSignature.publicKey, signature: consentSignature.signature } });
    assert.equal(submittedConsent.status, 201, JSON.stringify(submittedConsent.body));
    const access = await http.call(`/app/orders/access?organization=${ORG}&agent=${AGENT}`);
    assert.equal(access.status, 200, JSON.stringify(access.body));
    assert.equal(access.body.capable, true);
    assert.equal(access.body.consented, true);
    transcript.push('Dedicated treasury-orders consent and credentialed platform capability admitted order controls');

    const order = async requestId => {
      const terms = orderTerms(requestId);
      const quote = await http.call('/app/orders/quote', { method: 'POST', body: { organization: ORG, agent: AGENT,
        base_asset: terms.base_asset, quote_asset: terms.quote_asset, side: terms.side, quantity: terms.quantity,
        price: terms.price, confidential: terms.confidential, deadline: terms.deadline } });
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      assert.equal(quote.body.result.ok, true, JSON.stringify(quote.body));
      assert.equal(quote.body.result.value.spendAmount, '2370000');
      const created = await http.call('/app/orders', { method: 'POST', body: { organization: ORG, agent: AGENT, ...terms } });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      assert.equal(created.body.result.ok, true, JSON.stringify(created.body));
      assert.equal(created.body.result.value.state, 'proposed');
      const id = created.body.result.value.id;
      const read = await http.call(`/app/orders/${id}?organization=${ORG}&agent=${AGENT}`);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.sign.approve, limitOrderText(read.body.result.value, 'approve'));
      const wrong = await signed(`${read.body.sign.approve} `, read.body.sign.recipient);
      const refused = await http.call(`/app/orders/${id}/decide`, { method: 'POST', body: { organization: ORG,
        agent: AGENT, verdict: 'approve', signed: wrong } });
      assert.equal(refused.status, 200, JSON.stringify(refused.body));
      assert.equal(refused.body.result.ok, false, JSON.stringify(refused.body));
      assert.equal(refused.body.result.code, 'signature_text_mismatch', JSON.stringify(refused.body));
      assert.equal(refused.body.decisionHeld, false, 'a proven local refusal must allow a fresh exact owner signature');
      const afterRefusal = await http.call(`/app/orders/${id}?organization=${ORG}&agent=${AGENT}`);
      assert.equal(afterRefusal.body.result.value.state, 'proposed', JSON.stringify(afterRefusal.body));
      const approval = await signed(read.body.sign.approve, read.body.sign.recipient);
      const decided = await http.call(`/app/orders/${id}/decide`, { method: 'POST', body: { organization: ORG,
        agent: AGENT, verdict: 'approve', signed: approval } });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      assert.equal(decided.body.result.ok, true, JSON.stringify(decided.body));
      assert.equal(decided.body.result.value.state, 'approved');
      transcript.push(`Order ${requestId}: exact owner-signed terms approved`);
      return { id, terms };
    };
    const place = async id => {
      const reply = await http.call(`/app/orders/${id}/place`, { method: 'POST', body: { organization: ORG, agent: AGENT } });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return reply.body;
    };
    const refresh = async id => {
      const reply = await http.call(`/app/orders/${id}/refresh`, { method: 'POST', body: { organization: ORG, agent: AGENT } });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return reply.body;
    };
    const state = async () => value(await control('orderState'));

    const completed = await order('cross-completed');
    const placed = await place(completed.id);
    assert.equal(placed.result.ok, true, JSON.stringify(placed));
    assert.equal(placed.result.value.state, 'resting', JSON.stringify(placed));
    const completedProviderId = placed.result.value.orderId;
    assert(completedProviderId);
    value(await control('orderFill', { orderId: completedProviderId }));
    const partial = await refresh(completed.id);
    assert.equal(partial.result.value.state, 'partially_filled', JSON.stringify(partial));
    assert.equal(partial.result.value.isPayoutStatusFinal, false);
    value(await control('orderFillComplete', { orderId: completedProviderId }));
    const filledUnpaid = await refresh(completed.id);
    assert.notEqual(filledUnpaid.result.value.state, 'completed', JSON.stringify(filledUnpaid));
    assert.equal(filledUnpaid.result.value.isPayoutStatusFinal, false);
    value(await control('orderPayoutFinal', { orderId: completedProviderId, fillStatus: 'filled', payoutStatus: 'completed' }));
    const final = await refresh(completed.id);
    assert.equal(final.result.value.state, 'completed', JSON.stringify(final));
    assert.equal(final.result.value.isPayoutStatusFinal, true);
    transcript.push('Funded order stayed open on partial fill and fully filled pending payout; completed only after final payout evidence');

    const canceled = await order('cross-canceled');
    const cancelPlaced = await place(canceled.id);
    assert.equal(cancelPlaced.result.ok, true, JSON.stringify(cancelPlaced));
    const canceledProviderId = cancelPlaced.result.value.orderId;
    const beforeCancel = (await state()).cancelPosts;
    value(await control('dropOrderCancelReply'));
    const cancel = await http.call(`/app/orders/${canceled.id}/cancel`, { method: 'POST', body: { organization: ORG, agent: AGENT } });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assertNotFinal(cancel.body, 'lost cancellation reply');
    const canceledAfterLoss = await http.call(`/app/orders/${canceled.id}?organization=${ORG}&agent=${AGENT}`);
    assert.equal(canceledAfterLoss.status, 200, JSON.stringify(canceledAfterLoss.body));
    assertNotFinal(canceledAfterLoss.body, 'cancellation read after lost reply');
    assert.equal(canceledAfterLoss.body.attempts.cancel, true, 'lost cancellation must retain its local attempt');
    await restart();
    const canceledAfterRestart = await http.call(`/app/orders/${canceled.id}?organization=${ORG}&agent=${AGENT}`);
    assertNotFinal(canceledAfterRestart.body, 'cancellation read after restart');
    assert.equal(canceledAfterRestart.body.attempts.cancel, true, 'cancellation claim must survive restart');
    const cancelRepeated = await http.call(`/app/orders/${canceled.id}/cancel`, { method: 'POST', body: { organization: ORG, agent: AGENT } });
    assert.equal(cancelRepeated.status, 200, JSON.stringify(cancelRepeated.body));
    assertNotFinal(cancelRepeated.body, 'repeat cancellation action');
    const cancelRead = await refresh(canceled.id);
    assertNotFinal(cancelRead, 'cancellation refresh');
    assert.equal((await state()).cancelPosts, beforeCancel + 1, 'lost cancellation reply must not post twice');
    value(await control('orderPayoutFinal', { orderId: canceledProviderId, fillStatus: 'canceled', payoutStatus: 'completed' }));
    const cancelFinal = await refresh(canceled.id);
    assert.equal(cancelFinal.result.value.state, 'completed', JSON.stringify(cancelFinal));
    transcript.push('Lost cancellation reply remained one provider POST across an app restart');

    const lost = await order('cross-lost-placement');
    const beforePlace = (await state()).placementPosts;
    value(await control('dropOrderPlaceReply'));
    const lostPlace = await place(lost.id);
    assertNotFinal(lostPlace, 'lost placement reply');
    const lostAfterLoss = await http.call(`/app/orders/${lost.id}?organization=${ORG}&agent=${AGENT}`);
    assert.equal(lostAfterLoss.status, 200, JSON.stringify(lostAfterLoss.body));
    assertNotFinal(lostAfterLoss.body, 'placement read after lost reply');
    assert.equal(lostAfterLoss.body.attempts.place, true, 'lost placement must retain its local attempt');
    await restart();
    const lostAfterRestart = await http.call(`/app/orders/${lost.id}?organization=${ORG}&agent=${AGENT}`);
    assertNotFinal(lostAfterRestart.body, 'placement read after restart');
    assert.equal(lostAfterRestart.body.attempts.place, true, 'placement claim must survive restart');
    const placeRepeated = await place(lost.id);
    assertNotFinal(placeRepeated, 'repeat placement action');
    const placeRead = await refresh(lost.id);
    assertNotFinal(placeRead, 'placement refresh');
    assert.equal((await state()).placementPosts, beforePlace + 1, 'lost placement reply must not post twice');
    transcript.push('Lost placement reply remained one provider POST across an app restart');
    return { completed: completed.id, canceled: canceled.id, lost: lost.id,
      provider: await state(), transcript };
  } finally {
    await stopApp(server.child);
  }
}
