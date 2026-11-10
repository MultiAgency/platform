import { createServer } from 'node:http';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { DelegateAction, decodeSignedDelegateAction, serializeDelegateAction } from 'near-kit';
import { listen } from './provider.mjs';

/**
 * A simulated NEAR AI Agent Market (docs/market.md), offline: the published payee, listed agents over A2A + x402, and
 * the one piece of chain the payment key needs (its access-key nonce and USDC balance, and the block height). Shapes
 * follow the market's x402-caller skill 0.2.0; behaviour the docs leave open is marked where it is chosen here.
 *
 * A paid call's delegate action is relayed only when the agent delivers, as the docs say; a test can also relay it
 * itself (`relay`), as anyone holding the header could.
 */

export const MARKET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const MARKET_PAYEE = 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc';

/** How many blocks the market's view of the chain trails the final block. */
const MARKET_LAG_BLOCKS = 2n;
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const read = req => new Promise((resolve, reject) => {
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => resolve(text));
  req.on('error', reject);
});

/**
 * `agents`: handle → { amount (atomic USDC), windowSeconds, outcome: 'complete' | 'reject' | 'fail' | 'hold', result }.
 * `payee`: override the 402's payTo or asset (a market answering for someone else).
 */
export async function market({ agents = {}, payee = {}, height = 1_000_000n } = {}) {
  const chain = { height, accounts: new Map(), registered: new Set() };
  const tasks = new Map(), headers = new Set(), calls = [];
  // Keys in the order mainnet sends them (2026-11-09): `accepted` must repeat the row exactly, so a client that reorders
  // it fails here as it would there.
  const row = handle => ({ amount: agents[handle].amount, asset: payee.asset ?? MARKET_USDC, maxTimeoutSeconds: agents[handle].windowSeconds + 600,
    network: 'near:mainnet', payTo: payee.payTo ?? MARKET_PAYEE, scheme: 'exact' });
  const account = id => {
    if (!chain.accounts.has(id)) chain.accounts.set(id, { nonce: null, publicKey: null, balance: 0n, transfers: [] });
    return chain.accounts.get(id);
  };

  /** Applies a signed delegate action as the chain would: once, before its expiry, with a fresh nonce and the funds. */
  function relay(signedDelegateAction) {
    const { signedDelegate } = decodeSignedDelegateAction(Buffer.from(signedDelegateAction, 'base64'));
    const action = signedDelegate.delegateAction;
    const sender = account(action.senderId);
    if (chain.height > action.maxBlockHeight) return { relayed: false, reason: 'expired' };
    if (sender.nonce === null || action.nonce <= sender.nonce) return { relayed: false, reason: 'nonce' };
    const call = action.actions[0].functionCall;
    const args = JSON.parse(Buffer.from(call.args).toString());
    sender.nonce = action.nonce;
    if (BigInt(args.amount) > sender.balance) return { relayed: true, transferred: false };
    sender.balance -= BigInt(args.amount);
    sender.transfers.push({ receiverId: args.receiver_id, amount: args.amount });
    return { relayed: true, transferred: true };
  }

  /** Why the market refuses a header, or null: the row verbatim, a delegate paying exactly it, valid long enough. */
  function refusal(handle, header) {
    if (headers.has(header)) return 'x-payment header was already used';
    let payment;
    try { payment = JSON.parse(Buffer.from(header, 'base64').toString()); } catch { return 'x-payment header is unreadable'; }
    if (JSON.stringify(payment.accepted) !== JSON.stringify(row(handle))) return 'accepted is not the row this server sent';
    const { signedDelegate } = decodeSignedDelegateAction(Buffer.from(payment.payload.signedDelegateAction, 'base64'));
    const action = signedDelegate.delegateAction;
    const call = action.actions.length === 1 && action.actions[0].functionCall;
    const args = call && JSON.parse(Buffer.from(call.args).toString());
    if (!call || action.receiverId !== row(handle).asset || call.methodName !== 'ft_transfer' || call.deposit !== 1n
      || args.receiver_id !== row(handle).payTo || args.amount !== row(handle).amount) return 'the payment is not this row';
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(action.publicKey.ed25519Key.data)]), format: 'der', type: 'spki' });
    // The decoded action holds its key as Borsh data; the serializer takes a key object (ED25519 = 0).
    const signedBytes = serializeDelegateAction(new DelegateAction(action.senderId, action.receiverId, action.actions, action.nonce,
      action.maxBlockHeight, { keyType: 0, data: Uint8Array.from(action.publicKey.ed25519Key.data) }));
    const digest = createHash('sha256').update(signedBytes).digest();
    if (!verify(null, digest, key, Buffer.from(signedDelegate.signature.ed25519Signature.data))) return 'the payment signature does not verify';
    // Both bounds as the market applies them, from its own view of the chain, which trails the final block (mainnet,
    // 2026-11-09: a payment valid for exactly `maxTimeoutSeconds` from the latest block was refused with this code).
    const window = action.maxBlockHeight - (chain.height - MARKET_LAG_BLOCKS);
    if (window > BigInt(row(handle).maxTimeoutSeconds)) return 'invalid payment: invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout';
    if (window < BigInt(row(handle).maxTimeoutSeconds - 600)) return "the payment expires before the job's SLA window";
    if (account(action.senderId).balance < BigInt(args.amount)) return 'insufficient balance';
    return null;
  }

  const server = createServer((req, res) => handle(req, res).catch(error => json(res, 500, { error: String(error) })));
  async function handle(req, res) {
    const url = new URL(req.url, 'http://market');
    const text = req.method === 'POST' ? await read(req) : '';
    calls.push({ method: req.method, path: url.pathname, payment: req.headers['x-payment'] ?? null });
    if (req.method === 'GET' && url.pathname === '/.well-known/x402')
      return json(res, 200, { x402Version: 2, recipients: [{ network: 'near:mainnet', asset: MARKET_USDC, payTo: MARKET_PAYEE }] });
    const a2a = /^\/a2a\/([a-z0-9-]+)\/v1$/.exec(url.pathname);
    if (req.method === 'POST' && a2a) {
      const handle = a2a[1], { id, method, params } = JSON.parse(text);
      if (!agents[handle]) return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32001, message: 'no such agent' } });
      if (method === 'GetTask') {
        const task = tasks.get(params.id);
        return task ? json(res, 200, { jsonrpc: '2.0', id, result: task }) : json(res, 200, { jsonrpc: '2.0', id, error: { code: -32001, message: 'task not found' } });
      }
      if (method !== 'SendMessage') return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32004, message: 'not supported' } });
      const header = req.headers['x-payment'];
      if (!header) return json(res, 402, { x402Version: 2, error: 'x-payment header is required', accepts: [row(handle)] });
      const refused = refusal(handle, header);
      if (refused) return json(res, 402, { x402Version: 2, error: refused, accepts: [row(handle)] });
      headers.add(header);
      const { signedDelegateAction } = JSON.parse(Buffer.from(header, 'base64').toString()).payload;
      const agent = agents[handle], task = { id: randomUUID(), contextId: randomUUID(), status: { state: 'TASK_STATE_WORKING' } };
      tasks.set(task.id, task);
      // Chosen here: the delegate is relayed in the same step as delivery; the docs say only "settled at delivery".
      if (agent.outcome === 'complete') {
        relay(signedDelegateAction);
        Object.assign(task, { status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: agent.result ?? `done by ${handle}` }] }] });
      } else if (agent.outcome === 'reject') task.status = { state: 'TASK_STATE_REJECTED' };
      else if (agent.outcome === 'fail') task.status = { state: 'TASK_STATE_FAILED' };
      return json(res, 200, { jsonrpc: '2.0', id, result: { task } });
    }
    // The payment key's slice of the chain, as near-kit's RPC client asks for it.
    if (req.method === 'POST' && url.pathname === '/chain') {
      const { id, method, params } = JSON.parse(text);
      const ok = result => json(res, 200, { jsonrpc: '2.0', id, result });
      const fail = (name, cause) => json(res, 200, { jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000, message: 'Server error', data: cause } });
      if (method === 'block') return ok({ header: { height: Number(chain.height), hash: '11111111111111111111111111111111' }, chunks: [] });
      if (method === 'query' && params.request_type === 'view_access_key') {
        const holder = chain.accounts.get(params.account_id);
        // As mainnet answers for a missing key or an account that never existed (FastNear, 2026-11-09).
        if (!holder || holder.nonce === null) return ok({ block_height: Number(chain.height), error: `access key ${params.public_key} does not exist while viewing`, logs: [] });
        return ok({ nonce: Number(holder.nonce), permission: 'FullAccess', block_height: Number(chain.height), block_hash: '11111111111111111111111111111111' });
      }
      if (method === 'query' && params.request_type === 'call_function' && params.method_name === 'storage_balance_of') {
        const { account_id } = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        const value = chain.registered.has(account_id) ? { total: '1250000000000000000000', available: '0' } : null;
        return ok({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: Number(chain.height), block_hash: '11111111111111111111111111111111' });
      }
      if (method === 'query' && params.request_type === 'call_function' && params.method_name === 'ft_balance_of') {
        const { account_id } = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        const balance = chain.accounts.get(account_id)?.balance ?? 0n;
        return ok({ result: [...Buffer.from(JSON.stringify(balance.toString()))], logs: [], block_height: Number(chain.height), block_hash: '11111111111111111111111111111111' });
      }
      return fail('UNSUPPORTED', `${method} is not simulated`);
    }
    json(res, 404, { error: 'not found' });
  }
  /**
   * The stack's simulated chain asks here first (provider.mjs): the payment key's access key, its USDC and its
   * registration, for accounts this market's chain knows or the provider's doesn't. Null: not this chain's to answer.
   */
  function chainRequest({ id, params }, providerKnows) {
    if (!params?.account_id) return null;
    const result = value => ({ jsonrpc: '2.0', id, result: value });
    const viewed = value => result({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: Number(chain.height), block_hash: '11111111111111111111111111111111' });
    if (params.request_type === 'view_access_key' && !providerKnows(params.account_id)) {
      const holder = chain.accounts.get(params.account_id);
      return holder?.nonce != null
        ? result({ nonce: Number(holder.nonce), permission: 'FullAccess', block_height: Number(chain.height), block_hash: '11111111111111111111111111111111' })
        : result({ block_height: Number(chain.height), error: `access key ${params.public_key} does not exist while viewing`, logs: [] });
    }
    if (params.request_type !== 'call_function' || params.account_id !== MARKET_USDC) return null;
    const { account_id: holder } = JSON.parse(Buffer.from(params.args_base64 ?? '', 'base64').toString() || '{}');
    if (!holder || providerKnows(holder)) return null;
    if (params.method_name === 'ft_balance_of') return viewed((chain.accounts.get(holder)?.balance ?? 0n).toString());
    if (params.method_name === 'storage_balance_of') return viewed(chain.registered.has(holder) ? { total: '1250000000000000000000', available: '0' } : null);
    return null;
  }
  const port = await listen(server);
  return {
    chainRequest,
    url: `http://127.0.0.1:${port}`,
    rpc: `http://127.0.0.1:${port}/chain`,
    calls, tasks, chain,
    /** A top-up landing on the payment key's account: it exists, holds a key at nonce 0, and is credited. */
    fund(accountId, amount) {
      const holder = account(accountId);
      holder.nonce ??= 0n;
      holder.balance += BigInt(amount);
    },
    advance(blocks) { chain.height += BigInt(blocks); },
    /** The owner's one-time registration of an account on USDC (storage_deposit). */
    register(accountId) { chain.registered.add(accountId); },
    relay,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
