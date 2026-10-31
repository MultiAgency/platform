import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';
import { sign } from './provider.mjs';

// The running stack's file controls (stack.mjs) and its app credential. Every signature comes from the stack's unfunded
// fixture key, standing in for the owner's wallet. None of this is an application route.

/** A `fetch` for the stack's dashboard host, trusting only the stack's own certificate. */
const stackFetch = stack => (url, { method = 'GET', headers, body } = {}) => {
  const ca = readFileSync(join(stack.directory, 'localhost.crt'));
  return new Promise((resolve, reject) => {
    const req = request(new URL(url, stack.dashboard), { method, headers: Object.fromEntries(new Headers(headers)), ca }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const answered = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const one of [value].flat()) answered.append(name, one);
        resolve(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: answered }));
      });
    });
    req.on('error', reject); req.end(body);
  });
};
/** One HTTPS call to the stack's dashboard host: its status, headers and JSON body. */
async function call(stack, path, options) {
  const response = await stackFetch(stack)(path, options);
  return { status: response.status, headers: response.headers, body: JSON.parse((await response.text()) || 'null') };
}

/** A gateway session for `account`, signed in with the fixture key as the wallet would: the session cookie. */
async function session(stack, account) {
  const challenge = (await call(stack, '/gw/challenge')).body, signed = await sign(account, challenge);
  const answer = await call(stack, '/gw/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: stack.dashboard },
    body: JSON.stringify({ accountId: account, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }) });
  if (answer.status !== 200) throw new Error(`Sign-in as ${account} answered ${answer.status}`);
  return answer.headers.getSetCookie()[0].split(';')[0];
}

/** The operator's service credential for an app deployment on this host (`pnpm app-credential issue`): its `tap_` token. */
export async function appCredential(stack, deployment) {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '../../src/app-credential.ts'),
    'issue', deployment, new URL(stack.dashboard).host], { cwd: join(stack.directory, 'gateway'), env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS } });
  const token = stdout.trim().split('\n').at(-1);
  if (!/^tap_/.test(token)) throw new Error('The app credential was not issued');
  return token;
}

/** Each command takes the control file's arguments and answers a JSON value (or nothing). */
export function stackControls(stack, { owner }) {
  const { simulated } = stack, host = new URL(stack.dashboard).host;
  const portfolio = () => { if (!stack.portfolio) throw new Error('Start the stack with --treasury'); return stack.portfolio; };
  /** The simulated provider behind `agent`: the payout agent's by default, or `portfolio` (the Treasury agent's own). */
  const providerOf = agent => {
    if (agent === undefined || agent === 'payout') return simulated;
    if (agent === 'portfolio') return portfolio();
    throw new Error('agent is "payout" or "portfolio"');
  };
  return {
    fund: ({ agent, amount }) => simulated.fund(agent, amount),
    settle: ({ correlation }) => simulated.settle(correlation),
    dropTransferResponse: () => simulated.dropTransferResponse(),
    fundPayout: ({ amount }) => simulated.fundPayout(amount),
    dropSignatureResponse: ({ agent } = {}) => providerOf(agent).dropSignatureResponse(),
    revealOwnerOutcome: ({ agent } = {}) => providerOf(agent).revealOwnerOutcome(),
    setUnavailable: ({ value, agent }) => providerOf(agent).setUnavailable(value === true),
    /** The `portfolio` provider applies the `after`-th next swap but loses its reply: an `unknown` the agent must reconcile. */
    dropSwapResponse: ({ after = 1 } = {}) => {
      if (!Number.isInteger(after) || after < 1) throw new Error('after is a positive whole number');
      portfolio().dropSwapResponse(after);
    },
    /** Funds arriving on `portfolio`'s public balance outside a confidential deposit (raw units): what a sweep shields. */
    fundPublic: ({ asset, amount }) => portfolio().fundPublic(asset, amount),
    /**
     * The owner saves `portfolio`'s strategy through its own route (`strategy/save`, as the owner app does): `targetBps`
     * and any other strategy fields given, the rest kept. Saving turns autopilot off. Answers the saved strategy and digest.
     */
    setTargets: async ({ targetBps, ...settings }) => {
      portfolio();
      if (typeof targetBps !== 'object' || targetBps === null) throw new Error('Give targetBps');
      // The SDK's own client: stack.mjs runs on plain Node, so its TypeScript sources load through tsx.
      const { ownerClient } = await tsImport('../../src/contract/owner-client.ts', import.meta.url);
      const cookie = await session(stack, owner), send = stackFetch(stack);
      const treasury = ownerClient({ base: `${stack.dashboard}/a/portfolio`, fetch: (url, init = {}) =>
        send(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie, origin: stack.dashboard } }) });
      const answered = result => { if (!result.ok) throw new Error(`${result.kind}: ${result.message ?? ''}`); return result.value; };
      const current = answered(await treasury.call('strategy/get'));
      answered(await treasury.call('strategy/save', { strategy: { ...current.strategy, ...settings, targetBps }, expectedDigest: current.digest }));
      const saved = answered(await treasury.call('strategy/get'));
      return { strategy: saved.strategy, digest: saved.digest };
    },
    /**
     * The owner's NEP-413 signature over a text an app asked for: a consent, a setup, or a prepared intent's `payload`.
     * Never the platform's sign-in text, which an app must not ask an owner to sign (docs/agent-access.md).
     */
    signOwner: async ({ message, recipient, nonce }) => {
      if (typeof message !== 'string' || typeof recipient !== 'string' || typeof nonce !== 'string') throw new Error('Give message, recipient and nonce');
      if (message === `Sign in to ${host}`) throw new Error('An app never asks the owner to sign the platform sign-in text');
      const { publicKey, signature } = await sign(owner, { message, recipient, nonce });
      return { accountId: owner, publicKey, signature };
    },
    /** The Treasury owner issues a machine credential for `portfolio`, as on its access page: `{ credential, token }`. */
    machineCredential: async ({ label = 'stack', scopes, ttlSeconds }) => {
      portfolio();
      const answer = await call(stack, '/gw/machine-credentials/portfolio', { method: 'POST',
        headers: { 'content-type': 'application/json', origin: stack.dashboard, cookie: await session(stack, owner) },
        body: JSON.stringify({ label, scopes, ...(ttlSeconds !== undefined && { ttlSeconds }) }) });
      if (answer.status !== 201) throw new Error(`Issuing answered ${answer.status}: ${answer.body?.error}`);
      return answer.body;
    },
  };
}
