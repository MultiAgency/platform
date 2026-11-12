import { createServer } from 'node:http';
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
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
 * `agents`: handle → { amount (atomic USDC), windowSeconds, outcome: 'complete' | 'reject' | 'fail' | 'hold' | 'worker' | 'closed' | 'invalid' | 'broken', result }.
 * A `closed` agent is listed but not taking calls: it answers `-32004`, as the market's skill documents. An `invalid` one
 * answers the unpaid call `-32602` (the market refuses the request), a `broken` one `-32603` (an internal error).
 * `payee`: override the 402's payTo or asset (a market answering for someone else).
 */
export async function market({ agents = {}, payee = {}, height = 1_000_000n, webhookUrl = null, webhookSecret = null } = {}) {
  // Offline fixtures must never send a worker event to an external host, even if a stack caller supplies a URL.
  const webhookFor = handle => agents[handle].webhookUrl === null ? null : (agents[handle].webhookUrl ?? webhookUrl);
  for (const localUrl of [webhookUrl, ...Object.values(agents).map(agent => agent.webhookUrl)].filter(Boolean)) {
    const target = new URL(localUrl);
    if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password)
      throw new Error('The simulated market webhook must use local HTTP loopback');
  }
  const chain = { height, accounts: new Map(), registered: new Set() };
  const tasks = new Map(), taskOwners = new Map(), headers = new Set(), calls = [], assignments = new Map(), deliveries = new Map(), pendingWebhooks = new Set();
  const createdAt = new Date().toISOString();
  const listings = new Map(Object.entries(agents).map(([handle, agent]) => [handle, {
    agentId: randomUUID(), ownerId: randomUUID(), planId: randomUUID(),
    token: agent.outcome === 'worker' ? `aat_${randomBytes(32).toString('base64url')}` : null,
    secret: agent.outcome === 'worker' ? (webhookSecret ?? `whsec_${randomBytes(32).toString('hex')}`) : null,
  }]));
  const listing = handle => {
    const agent = agents[handle], identity = listings.get(handle);
    return { agent_id: identity.agentId, owner_account_id: identity.ownerId, handle, name: agent.name ?? handle,
      category: agent.category ?? 'research', tags: agent.tags ?? [], runtime: agent.outcome === 'worker' ? 'http' : 'managed',
      listing_status: 'live', delivered_jobs: [...assignments.values()].filter(item => item.handle === handle && item.assignment.status === 'accepted').length,
      sla_seconds: agent.windowSeconds, required_slots: [], funding_paused: false,
      availability: agent.outcome === 'closed' ? 'paused' : 'available', available_now: agent.outcome !== 'closed',
      created_at: createdAt, updated_at: createdAt };
  };
  const worker = req => {
    const token = /^Bearer (aat_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
    return [...listings].find(([, identity]) => identity.token && identity.token === token)?.[0] ?? null;
  };
  const workerAuth = (req, res) => {
    const handle = worker(req);
    if (!handle) json(res, 401, { error: 'invalid_agent_token' });
    return handle;
  };
  async function sendWebhook(assignmentId) {
    const delivery = deliveries.get(assignmentId);
    if (!delivery) return null;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', listings.get(delivery.handle).secret).update(`${timestamp}.`).update(delivery.body).digest('hex');
    const response = await fetch(delivery.url, { method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { 'content-type': 'application/json', 'x-market-event': 'hire.created', 'x-market-delivery': delivery.id,
        'x-market-timestamp': timestamp, 'x-market-signature': `sha256=${signature}` }, body: delivery.body });
    if (response.ok) assignments.get(assignmentId).assignment.startedAt ??= new Date().toISOString();
    return response.status;
  }
  function queueWebhook(assignmentId) {
    const pending = sendWebhook(assignmentId).catch(() => null).finally(() => pendingWebhooks.delete(pending));
    pendingWebhooks.add(pending);
  }
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
    if (req.method === 'GET' && url.pathname === '/v1/agents') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const matches = [...listings.keys()].filter(handle => {
        const agent = agents[handle];
        return (!q || [handle, agent.name ?? handle, agent.description ?? ''].some(value => value.toLowerCase().includes(q)))
          && (!url.searchParams.has('category') || (agent.category ?? 'research') === url.searchParams.get('category'));
      });
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
      return json(res, 200, { agents: matches.slice(offset, offset + limit).map(listing) });
    }
    const pricing = /^\/v1\/agents\/([^/]+)\/pricing-plans$/.exec(url.pathname);
    if (req.method === 'GET' && pricing) {
      const handle = [...listings].find(([name, identity]) => identity.agentId === pricing[1] || name === pricing[1])?.[0];
      if (!handle) return json(res, 404, { error: 'agent_not_found' });
      const identity = listings.get(handle), agent = agents[handle];
      const amount = BigInt(agent.amount);
      return json(res, 200, [{ pricing_plan_id: identity.planId, agent_id: identity.agentId, model: 'per_call',
        price_amount: `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`,
        is_default: true, listing_status: agent.outcome === 'closed' ? 'paused' : 'live',
        sla_seconds: agent.windowSeconds, created_at: createdAt, updated_at: createdAt }]);
    }
    const reputation = /^\/v1\/agents\/([^/]+)\/reputation$/.exec(url.pathname);
    if (req.method === 'GET' && reputation) {
      const handle = [...listings].find(([name, identity]) => identity.agentId === reputation[1] || name === reputation[1])?.[0];
      if (!handle) return json(res, 404, { error: 'agent_not_found' });
      return json(res, 200, { axes: {}, jobs_counted: 0, min_scored_jobs: 5, min_answered_reviews: 5, overall: null, baseline: null });
    }
    if (req.method === 'GET' && url.pathname === '/v1/agents/me/assignments') {
      const handle = workerAuth(req, res);
      if (!handle) return;
      const status = url.searchParams.get('status') ?? 'in_progress';
      if (!['all', 'in_progress', 'submitted', 'accepted'].includes(status)) return json(res, 400, { error: 'invalid_status' });
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      const mine = [...assignments.values()].filter(item => item.handle === handle && (status === 'all' || item.assignment.status === status));
      return json(res, 200, { assignments: mine.slice(offset, offset + limit).map(({ assignment, job }) => ({ assignment, job, latestMessage: null })) });
    }
    const assignmentRoute = /^\/v1\/assignments\/([^/]+)\/(start|submit)$/.exec(url.pathname);
    if (req.method === 'POST' && assignmentRoute) {
      const handle = workerAuth(req, res);
      if (!handle) return;
      const item = assignments.get(assignmentRoute[1]);
      if (!item) return json(res, 404, { error: 'assignment_not_found' });
      if (item.handle !== handle) return json(res, 403, { error: 'agent_token_scope_forbidden' });
      if (assignmentRoute[2] === 'start') {
        item.assignment.startedAt ??= new Date().toISOString();
        item.assignment.updatedAt = new Date().toISOString();
        return json(res, 200, { startedAt: item.assignment.startedAt });
      }
      let body;
      try { body = JSON.parse(text); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const markdown = body?.deliverableMarkdown;
      if (typeof markdown !== 'string' || !Buffer.byteLength(markdown) || Buffer.byteLength(markdown) > 256 * 1024 || (body.files?.length ?? 0))
        return json(res, 400, { error: 'invalid_deliverable' });
      if (item.assignment.status !== 'in_progress') return json(res, 409, { error: 'assignment_not_in_progress' });
      const now = new Date().toISOString();
      Object.assign(item.assignment, { status: 'submitted', submittedAt: now, updatedAt: now,
        deliverableHash: createHash('sha256').update(markdown).digest('hex') });
      // The response shows the submission. X402 accepts immediately on delivery, but only after the delegate
      // actually transfers; an expired or unusable delegate must never make the simulated buyer look paid.
      const submitted = { ...item.assignment };
      const paid = relay(item.signedDelegateAction);
      if (paid.transferred) {
        Object.assign(item.assignment, { status: 'accepted', finalizedAt: now, updatedAt: now });
        item.job.status = 'completed';
        Object.assign(item.task, { status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: markdown }] }] });
      }
      return json(res, 200, submitted);
    }
    const a2a = /^\/a2a\/([a-z0-9-]+)\/v1$/.exec(url.pathname);
    if (req.method === 'POST' && a2a) {
      const handle = a2a[1], { id, method, params } = JSON.parse(text);
      if (!agents[handle]) return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32001, message: 'no such agent' } });
      if (method === 'GetTask') {
        const task = tasks.get(params.id);
        return task && taskOwners.get(params.id) === handle ? json(res, 200, { jsonrpc: '2.0', id, result: task })
          : json(res, 200, { jsonrpc: '2.0', id, error: { code: -32001, message: 'task not found' } });
      }
      if (method !== 'SendMessage') return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32004, message: 'not supported' } });
      if (agents[handle].outcome === 'closed') return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32004, message: 'not taking calls' } });
      if (agents[handle].outcome === 'invalid') return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } });
      if (agents[handle].outcome === 'broken') return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
      const header = req.headers['x-payment'];
      if (!header) return json(res, 402, { x402Version: 2, error: 'x-payment header is required', accepts: [row(handle)] });
      const refused = refusal(handle, header);
      if (refused) return json(res, 402, { x402Version: 2, error: refused, accepts: [row(handle)] });
      headers.add(header);
      const { signedDelegateAction } = JSON.parse(Buffer.from(header, 'base64').toString()).payload;
      const agent = agents[handle], task = { id: randomUUID(), contextId: randomUUID(), status: { state: 'TASK_STATE_WORKING' } };
      tasks.set(task.id, task); taskOwners.set(task.id, handle);
      if (agent.outcome === 'worker') {
        const now = new Date().toISOString(), identity = listings.get(handle), brief = params?.message?.parts?.map(part => part.text ?? '').join('\n') ?? '';
        const bidId = randomUUID(), assignment = { assignmentId: task.id, jobId: task.contextId, workerAgentId: identity.agentId,
          status: 'in_progress', escrowAmount: `${BigInt(agent.amount) / 1_000_000n}.${(BigInt(agent.amount) % 1_000_000n).toString().padStart(6, '0')}`,
          escrowToken: 'X402', slaSeconds: agent.windowSeconds, slaDeadlineAt: new Date(Date.now() + agent.windowSeconds * 1_000).toISOString(),
          acceptanceWindowDays: 3, createdAt: now, updatedAt: now, startedAt: null, submittedAt: null, deliverableUrl: null, bidId };
        const job = { jobId: task.contextId, title: brief.split('\n')[0] || `Hire ${handle}`, description: brief, tags: agent.tags ?? [],
          jobKind: 'instant', status: 'in_progress', attachments: [] };
        assignments.set(task.id, { handle, task, assignment, job, signedDelegateAction });
        if (webhookFor(handle)) {
          const body = JSON.stringify({ event: 'hire.created', job_id: job.jobId, assignment_id: assignment.assignmentId,
            bid_id: bidId, hire_id: randomUUID(), title: job.title, description: brief, tags: job.tags, kind: 'instant',
            amount: assignment.escrowAmount, token: 'X402', sla_seconds: agent.windowSeconds, sla_deadline_at: assignment.slaDeadlineAt,
            attachments: [], mcp: { broker_url: '/mcp', session_token: `mcpbs_${randomBytes(32).toString('base64url')}`,
              expires_at: new Date(Date.now() + 12 * 3_600_000).toISOString() } });
          deliveries.set(task.id, { id: randomUUID(), handle, body, url: webhookFor(handle) });
          queueWebhook(task.id);
        }
      }
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
    calls, tasks, assignments, chain,
    handles: [...listings.keys()], workerHandles: [...listings.keys()].filter(handle => agents[handle].outcome === 'worker'),
    /** Fixture-only worker credentials. The stack writes them to a private file, never its public state. */
    credentials(handle) {
      const identity = listings.get(handle);
      if (!identity?.token) throw new Error(`${handle} is not a simulated worker`);
      return { agentId: identity.agentId, token: identity.token, webhookSecret: identity.secret };
    },
    /** Repeat exactly one delivery ID and body to exercise receiver deduplication. */
    redeliver(assignmentId) { if (!deliveries.has(assignmentId)) throw new Error('No webhook delivery for this assignment'); return sendWebhook(assignmentId); },
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
    close: async () => { await Promise.allSettled([...pendingWebhooks]); await new Promise(resolve => server.close(resolve)); },
  };
}
