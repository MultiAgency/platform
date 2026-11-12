import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';
import { sign, signDelegate } from './provider.mjs';

// The running stack's file controls (stack.mjs) and its app credential. Every signature comes from the stack's unfunded
// fixture key, standing in for the owner's or a payee's wallet. None of this is an application route.

/** A `fetch` for the stack's dashboard host, trusting only the stack's own certificate. */
export const stackFetch = stack => (url, { method = 'GET', headers, body } = {}) => {
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

/**
 * Each command takes the control file's arguments and answers a JSON value (or nothing). `payees`: the stack's payee
 * accounts (`--payee`, `--builder`), which `signPayee` signs for.
 * @param {any} stack
 * @param {{ owner: string; payees?: string[] }} options
 */
export function stackControls(stack, { owner, payees = [] }) {
  const { simulated } = stack, host = new URL(stack.dashboard).host;
  /** A NEP-413 signature by `account` over an app's text: never the platform's sign-in text, which an app must not ask anyone to sign (docs/app-access.md). */
  const signText = async (account, { message, recipient, nonce }) => {
    if (typeof message !== 'string' || typeof recipient !== 'string' || typeof nonce !== 'string') throw new Error('Give message, recipient and nonce');
    if (message === `Sign in to ${host}`) throw new Error('An app never asks anyone to sign the platform sign-in text');
    const { publicKey, signature } = await sign(account, { message, recipient, nonce });
    return { accountId: account, publicKey, signature };
  };
  const portfolio = () => { if (!stack.portfolio) throw new Error('Start the stack with --treasury'); return stack.portfolio; };
  /** The simulated provider behind `agent`: the payout agent's by default, or `portfolio` (the Treasury agent's own). */
  const providerOf = agent => {
    if (agent === undefined || agent === 'payout') return simulated;
    if (agent === 'portfolio') return portfolio();
    throw new Error('agent is "payout" or "portfolio"');
  };
  const answered = result => { if (!result.ok) throw new Error(`${result.kind}: ${result.message ?? ''}`); return result.value; };
  /** `portfolio`'s owner signed in with the fixture key, through the SDK's own client (TypeScript sources load through tsx). */
  const ownerTreasury = async () => {
    portfolio();
    const { ownerClient } = await tsImport('../../src/contract/owner-client.ts', import.meta.url);
    const cookie = await session(stack, owner), send = stackFetch(stack);
    return ownerClient({ base: `${stack.dashboard}/a/portfolio`, fetch: (url, init = {}) =>
      send(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie, origin: stack.dashboard } }) });
  };
  return {
    fund: ({ agent, amount }) => simulated.fund(agent, amount),
    /** An approved payment ends: `outcome` `SUCCESS` (default), `FAILED` or `REFUNDED`. */
    settle: ({ correlation, outcome }) => simulated.settle(correlation, outcome),
    dropTransferResponse: () => simulated.dropTransferResponse(),
    /** The provider accepts the next withdrawal but its response is lost. */
    dropWithdrawResponse: () => simulated.dropWithdrawResponse(),
    /** `account` is not registered on `asset`'s token (default USDC): a USDC withdrawal to it is refused `recipient_not_registered`. */
    unregister: ({ account, asset }) => simulated.unregister(account, asset),
    /** The provider refuses the next transfer or withdrawal by its rules (`code`, at HTTP `status`), recording nothing. */
    refuseNextPayout: ({ code, status }) => simulated.refuseNextPayout({ code, status }),
    /** A held payment's approval reads expired: the platform refuses a vote on it. */
    expireApproval: ({ correlation }) => simulated.expireApproval(correlation),
    fundPayout: ({ amount }) => simulated.fundPayout(amount),
    // The simulated agent market (`--market`, docs/market.md): the owner's one-time registration of a market agent's payment
    // key on USDC (the transaction `market/account` hands the app, simulated), and the market chain's blocks moving on, so a
    // hire's unused payment expires and reads not charged.
    marketRegister: ({ account }) => { if (!stack.market) throw new Error('Start the stack with --market'); if (typeof account !== 'string') throw new Error('Give account'); stack.market.register(account); },
    marketAdvance: ({ blocks }) => { if (!stack.market) throw new Error('Start the stack with --market'); stack.market.advance(Number(blocks ?? 1_300)); },
    marketRedeliver: async ({ assignmentId }) => { if (!stack.market) throw new Error('Start the stack with --market');
      if (typeof assignmentId !== 'string') throw new Error('Give assignmentId'); return stack.market.redeliver(assignmentId); },
    dropSignatureResponse: ({ agent } = {}) => providerOf(agent).dropSignatureResponse(),
    revealOwnerOutcome: ({ agent } = {}) => providerOf(agent).revealOwnerOutcome(),
    setUnavailable: ({ value, agent }) => providerOf(agent).setUnavailable(value === true),
    /** The `portfolio` provider applies the `after`-th next swap but loses its reply: an `unknown` the agent must reconcile. */
    dropSwapResponse: ({ after = 1 } = {}) => {
      if (!Number.isInteger(after) || after < 1) throw new Error('after is a positive whole number');
      portfolio().dropSwapResponse(after);
    },
    /** A listed token's USD price moves (a positive decimal): every later quote and valuation uses it. */
    setPrice: ({ asset, price }) => portfolio().setPrice(asset, price),
    /** Funds arriving on `portfolio`'s public balance outside a confidential deposit (raw units): what a sweep shields. */
    fundPublic: ({ asset, amount }) => portfolio().fundPublic(asset, amount),
    /**
     * The owner saves `portfolio`'s strategy through its own route (`strategy/save`, as the owner app does): `targetBps`
     * and any other strategy fields given, the rest kept. Saving turns autopilot off. Answers the saved strategy and digest.
     */
    setTargets: async ({ targetBps, ...settings }) => {
      if (typeof targetBps !== 'object' || targetBps === null) throw new Error('Give targetBps');
      const treasury = await ownerTreasury();
      const current = answered(await treasury.call('strategy/get'));
      answered(await treasury.call('strategy/save', { strategy: { ...current.strategy, ...settings, targetBps }, expectedDigest: current.digest }));
      const saved = answered(await treasury.call('strategy/get'));
      return { strategy: saved.strategy, digest: saved.digest };
    },
    /** The owner reads `portfolio`'s books through its own route (`reconcileBooks`): each balance against its record. */
    reconcileBooks: async () => answered(await (await ownerTreasury()).call('reconcileBooks')),
    /**
     * The owner reviews `portfolio`'s saved strategy and signs a grant bound to it (`treasury:<suffix>`), through its own
     * route, with the fixture key: what an app's or a machine credential's plans need before they execute. Answers the
     * digest the grant binds.
     */
    authorizeStrategy: async () => {
      const treasury = await ownerTreasury();
      const { digest } = answered(await treasury.call('strategy/get'));
      const prepared = answered(await treasury.call('owner/prepare', { action: { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: digest }, signer: 'wallet' }));
      const { publicKey, signature } = await sign(owner, prepared.intent.payload);
      answered(await treasury.call('owner/submit', { correlationId: prepared.correlationId,
        signedData: { ...prepared.intent, public_key: publicKey, signature } }));
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 250))) {
        const { status } = answered(await treasury.call('owner/status', { correlationId: prepared.correlationId }));
        if (status === 'SUCCESS') return { digest };
        if (status === 'FAILED') throw new Error('The strategy grant failed');
      }
      throw new Error('The strategy grant did not settle');
    },
    /**
     * The DAO passes the proposal that signs `hash` (a DAO request's NEP-413 hash, as the `v1.signer` call in the member's
     * transaction names it): the simulated MPC key signs it, as an executed proposal's receipt would return it.
     */
    daoVote: ({ hash }) => {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Give hash: the 64-hex hash the DAO signs');
      simulated.daoVote(hash);
    },
    /**
     * The simulated DAO is set up for confidential intents, as Trezu's confidential setup registers its key on
     * `intents.near` (`add_public_key`): `treasury/get` reads it `confidential` from then on. Start with `--dao-treasury`.
     */
    daoConfidentialSetup: () => simulated.daoConfidentialSetup(),
    /**
     * The owner's NEP-413 signature over a text an app asked for: a consent, a setup, or a prepared intent's `payload`.
     * Never the platform's sign-in text, which an app must not ask an owner to sign (docs/app-access.md).
     */
    signOwner: input => signText(owner, input),
    /** A payee's NEP-413 signature over an app's own text (`account` one of the stack's payees), as for `signOwner`. */
    signPayee: ({ account, ...input }) => {
      if (!payees.includes(account)) return Promise.reject(new Error(`${account} is not one of the stack's payees (${payees.join(', ')})`));
      return signText(account, input);
    },
    /**
     * The owner's NEP-366 signature over a delegate action, as the platform's confirm page asks the wallet for it
     * (`signDelegateActions`): `{ receiverId, actions }` of function calls in, `{ accountId, signedDelegate }` out, the
     * signed delegate base64 as near-connect returns it. Only function calls, as the confirm page's actions are.
     */
    signOwnerDelegate: ({ receiverId, actions }) => {
      if (typeof receiverId !== 'string' || !Array.isArray(actions) || !actions.length
        || !actions.every(a => a?.type === 'FunctionCall' && typeof a.params?.methodName === 'string' && typeof a.params.gas === 'string' && typeof a.params.deposit === 'string'))
        throw new Error('Give receiverId and actions: function calls with methodName, args, gas and deposit');
      return { accountId: owner, signedDelegate: signDelegate(owner, { receiverId, actions }) };
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
