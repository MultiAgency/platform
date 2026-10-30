import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sign } from './provider.mjs';

// The running stack's file controls (stack.mjs) and its app credential. Every signature comes from the stack's unfunded
// fixture key, standing in for the owner's wallet. None of this is an application route.

/** One HTTPS call to the stack's dashboard host, trusting only the stack's own certificate. */
function call(stack, path, { method = 'GET', headers = {}, body } = {}) {
  const ca = readFileSync(join(stack.directory, 'localhost.crt'));
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, stack.dashboard), { method, headers, ca }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject); req.end(body);
  });
}

/** A gateway session for `account`, signed in with the fixture key as the wallet would: the session cookie. */
async function session(stack, account) {
  const challenge = (await call(stack, '/gw/challenge')).body, signed = await sign(account, challenge);
  const answer = await call(stack, '/gw/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: stack.dashboard },
    body: JSON.stringify({ accountId: account, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }) });
  if (answer.status !== 200) throw new Error(`Sign-in as ${account} answered ${answer.status}`);
  return answer.headers['set-cookie'][0].split(';')[0];
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
  return {
    fund: ({ agent, amount }) => simulated.fund(agent, amount),
    settle: ({ correlation }) => simulated.settle(correlation),
    dropTransferResponse: () => simulated.dropTransferResponse(),
    fundPayout: ({ amount }) => simulated.fundPayout(amount),
    dropSignatureResponse: () => simulated.dropSignatureResponse(),
    revealOwnerOutcome: () => simulated.revealOwnerOutcome(),
    setUnavailable: ({ value }) => simulated.setUnavailable(value === true),
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
      if (!stack.portfolio) throw new Error('Start the stack with --treasury');
      const answer = await call(stack, '/gw/machine-credentials/portfolio', { method: 'POST',
        headers: { 'content-type': 'application/json', origin: stack.dashboard, cookie: await session(stack, owner) },
        body: JSON.stringify({ label, scopes, ...(ttlSeconds !== undefined && { ttlSeconds }) }) });
      if (answer.status !== 201) throw new Error(`Issuing answered ${answer.status}: ${answer.body?.error}`);
      return answer.body;
    },
  };
}
