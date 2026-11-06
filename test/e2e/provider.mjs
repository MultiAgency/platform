import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createGrantCredential, grantCommitment } from '@near-intents-agent-api/sdk';
import { DelegateAction, encodeSignedDelegateAction, Near, parseKey, serializeDelegateAction } from 'near-kit';
import { rawKey } from '../../src/nep413.ts';

// Generated for each local environment. Never load application credentials or funded keys.
export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const OWNER = 'owner.near', PAYEE = 'payee.near';
/**
 * The listed tokens (`/v1/tokens`) at market-like prices, none of them whole, so every USD value carries a fraction; a
 * Treasury swap between any two of them is quoted from these prices.
 */
const TOKENS = [
  { asset_id: USDC, symbol: 'USDC', decimals: 6, price: 0.9997 },
  { asset_id: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, price: 2.37 },
  { asset_id: 'nep141:eth.omft.near', symbol: 'ETH', decimals: 18, price: 3120.55 },
];
/** A listed price as an exact fraction (0.9997 is 9997/10000), or undefined for anything but a positive decimal. */
const fraction = price => {
  const [, whole, decimals = ''] = /^(\d+)(?:\.(\d+))?$/.exec(String(price)) ?? [];
  if (whole === undefined || !(price > 0)) return undefined;
  return { numerator: BigInt(whole + decimals), denominator: 10n ** BigInt(decimals.length) };
};
/** `amount` of `from` in `to` at the listed prices, rounded down, exact in BigInt. */
const convert = (from, to, amount) => {
  const priceIn = fraction(from.price), priceOut = fraction(to.price);
  return amount * priceIn.numerator * priceOut.denominator * 10n ** BigInt(to.decimals)
    / (priceIn.denominator * priceOut.numerator * 10n ** BigInt(from.decimals));
};
/** An account with no agent of its own: it signs in only where a host allows self-service sessions. */
export const SECOND = 'second.near';
/** A builder: on chain, not yet an agreed payee until the owner adds it through a policy update. */
export const BUILDER = 'builder.near';
export const TEST_KEY = 'ed25519:vbKRaNtGLifEXMGHhMgHEnHyuLjX1Hb6VdEDQJ4NkARFxCcx4AYdyeLRLuLsoGbuDtwUZBHKtJkzM5RzBRafzNk';
export const PUBLIC_KEY = parseKey(TEST_KEY).publicKey.toString();
/**
 * A Sputnik DAO for shared-reader scenarios: the council (OWNER) may propose, vote and manage; the member (SECOND) may
 * only vote. Its MPC signer derives the test key, so the agent's owner is that key's implicit account.
 */
export const DAO = 'council.sputnik-dao.near';
export const DAO_SIGNER = rawKey(PUBLIC_KEY).toString('hex');
const daoPolicy = { proposal_bond: '100000000000000000000000', proposal_period: '604800000000000', default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] }, roles: [
  { name: 'council', kind: { Group: [OWNER] }, permissions: ['*:AddProposal', '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize'], vote_policy: {} },
  { name: 'members', kind: { Group: [SECOND] }, permissions: ['call:VoteApprove', 'call:VoteReject'], vote_policy: {} },
] };
export async function sign(account, payload) {
  const near = new Near({ network: 'mainnet', privateKey: TEST_KEY, defaultSignerId: account });
  return { accountId: account, ...await near.signMessage({ ...payload, nonce: Buffer.from(payload.nonce, 'base64') }) };
}
/** A wallet signing a delegate action (NEP-366) with the local test key, in the base64 transport form. */
export function signDelegate(account, { receiverId, actions }) {
  const key = parseKey(TEST_KEY), publicKey = key.publicKey;
  const calls = actions.map(({ params }) => ({ functionCall: { methodName: params.methodName, args: new TextEncoder().encode(JSON.stringify(params.args)),
    gas: BigInt(params.gas), deposit: BigInt(params.deposit) } }));
  const action = new DelegateAction(account, receiverId, calls, 1n, 1_000_000n, publicKey);
  const signature = key.sign(createHash('sha256').update(serializeDelegateAction(action)).digest());
  return encodeSignedDelegateAction({ signedDelegate: {
    delegateAction: { senderId: account, receiverId, actions: calls, nonce: 1n, maxBlockHeight: 1_000_000n, publicKey: { ed25519Key: { data: Array.from(publicKey.data) } } },
    signature: { ed25519Signature: { data: Array.from(signature.data) } } } });
}
export const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const json = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const bodyOf = async req => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : null; };

/** Policy fields the provider enforces, so an edit to any of them is signed on chain (provider skills `references/policy.md`). */
const PROVIDER_FIELDS = ['frozen', 'actions', 'confidential', 'owner_approval', 'assets', 'limits', 'max_actions_per_hour'];
/**
 * `account` owns the configured agent; `payees` are its agreed destinations; `accounts` only exist on chain.
 * `onChainPolicyEdits`: freeze, unfreeze and a policy update that changes a provider-enforced field come back as NEP-366
 * delegates to `outlayer.near` (`freeze_wallet`, `unfreeze_wallet`; `store_wallet_policy` with an opaque payload), per
 * the provider's docs (the call arguments are not observed here); by default every owner intent is NEP-413.
 */
export async function provider(directory, { treasury = false, account = OWNER, payees = [PAYEE], accounts = [], dao = false, payoutFunding = 100000000n, onChainPolicyEdits = false } = {}) {
  const id = randomBytes(32).toString('hex');
  const credential = createGrantCredential();
  const owner = { type: 'near', account_id: account, public_key: PUBLIC_KEY };
  const wallet = { wallet_id: 'local-wallet', near_account_id: 'local-wallet.near' };
  const policy = { frozen: false, actions: ['transfer'], confidential: true, owner_approval: true, assets: [USDC],
    destinations: { mode: 'only', list: payees.map(address => ({ action: 'transfer', address, confidential: true })) },
    limits: { per_transaction: { [USDC]: '25000000' } }, max_actions_per_hour: 10,
    budget: { daily_usd: '50', weekly_usd: null, monthly_usd: '200' }, timelock_ms: 0 };
  if (treasury) { policy.actions = ['swap']; policy.owner_approval = false; policy.assets = 'any'; policy.destinations.list = []; }
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const grant = { grant_id: 'local-grant', agent_id: id, wallet_id: wallet.wallet_id, label: 'invoices',
    issued_at: new Date().toISOString(), expires_at: expires, revoked_at: null, revoked_reason: null, owner_epoch: 1,
    owner_message: { domain: 'near-intents-agent-api.agent-grant.v6', owner, tenant_id: 'local', agent_id: id,
      wallet_id: wallet.wallet_id, label: 'invoices', credential: credential.commitment, network: 'mainnet',
      issued_at_ms: Date.now(), expires_at_ms: Date.parse(expires), owner_epoch: 1, nonce: 'local', recipient: 'local' } };
  const grants = [grant];
  /**
   * A Treasury agent's balances: confidential (what it swaps) and public (funds that arrived outside a confidential
   * deposit, `fundPublic`: what a sweep shields). The configured agent starts with 100 USDC; one the owner creates with
   * a swap policy starts empty.
   */
  const treasuryState = (usdc = 0n) => ({ confidential: new Map(TOKENS.map(({ asset_id }) => [asset_id, asset_id === USDC ? usdc : 0n])),
    public: new Map(TOKENS.map(({ asset_id }) => [asset_id, 0n])) });
  // The configured agent plus any the owner creates (work orders, hosted agents). Each keeps its own policy, grants and
  // funding; a Treasury one its own balances.
  const agents = new Map([[id, { id, owner, wallet, policy, revision: 1, grants, funded: BigInt(payoutFunding), ...(treasury && { treasury: treasuryState(100000000n) }) }]]);
  const requests = [], errors = [], transfers = [], intents = [], swaps = [], shields = [], deposits = [];
  /** A delegate to `outlayer.near` calling `methodName` once, as the provider's NEP-366 owner intents are shaped. */
  const delegate = (methodName, args) => ({ standard: 'nep366', payload: { receiverId: 'outlayer.near', actions: [{ type: 'FunctionCall', params: { methodName,
    args, gas: '30000000000000', deposit: '0' } }] } });
  const spent = agent => transfers.filter(p => p.agent === agent.id && p.status === 'SUCCESS').reduce((sum, p) => sum + BigInt(p.body.amount), 0n);
  const liveGrant = (agent, token) => typeof token === 'string' && agent.grants.some(g => !g.revoked_at && Date.parse(g.expires_at) > Date.now() && g.owner_message.credential === grantCommitment(token));
  if (treasury) { grant.label = 'treasury'; grant.owner_message.label = 'treasury'; }
  let unavailable = false, outageRefusals = 0;
  let dropSwapAt = 0, observationGate, quoteWarnings = [];

  const swapStatus = swap => ({ correlation_id: swap.correlation_id, agent_id: swap.agent, type: 'swap', status: 'SUCCESS', created_at: swap.at, updated_at: swap.at,
    failure_code: null, details: { action: 'swap', request: { origin_asset: swap.body.origin_asset, destination_asset: swap.body.destination_asset,
      amount: swap.body.amount, min_amount_out: swap.body.min_amount_out, confidential: true }, confidential: true, amount_out: swap.amountOut } });
  const status = payment => ({ correlation_id: payment.correlation, agent_id: payment.agent, type: payment.type ?? 'transfer', status: payment.status,
    created_at: payment.at, updated_at: payment.at, failure_code: payment.failure ?? null, details: { approval_id: payment.approval } });
  // A held withdrawal's approval shape isn't observed on mainnet: modelled here as OutLayer's `Withdraw` op, only so a
  // reject has an approval to name. The platform never approves one.
  const approval = payment => {
    const data = payment.type === 'withdraw' ? { amount: payment.body.amount, kind: 'withdraw', to: payment.body.recipient, token: payment.body.asset }
      : { amount: payment.body.amount, chain: 'near', flow: 'transfer', kind: 'confidential', to: payment.body.recipient, token: payment.body.asset };
    return { approval_id: payment.approval, wallet_id: agents.get(payment.agent).wallet.wallet_id, status: payment.status === 'PENDING_APPROVAL' ? 'PENDING' : payment.failure === 'rejected_by_owner' ? 'REJECTED' : 'APPROVED',
      expires_at: expires, request_type: payment.type === 'withdraw' ? 'withdraw' : 'confidential', request_data: data,
      request_hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
  };
  let dropNextTransfer = false, dropNextSignature = false, ownerOutcomeUnavailable = false;
  /** Passed DAO proposals that called `v1.signer`: the transaction and the signature its receipt returns (`daoVote`). */
  const daoVotes = [];
  /** The chain's height: each passed vote lands in a later block than anything prepared before it. */
  const height = () => 1_000 + daoVotes.length;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local'), body = await bodyOf(req);
      const entry = { method: req.method, path: url.pathname, query: url.search, body, key: req.headers['idempotency-key'] };
      requests.push(entry); appendFileSync(`${directory}/provider.jsonl`, JSON.stringify(entry) + '\n');
      // FastNEAR's transaction API, as the DAO-signature search reads it (test/e2e/fastnear-fixture.cjs routes it here).
      if (url.pathname === '/fastnear/v0/account')
        return json(res, { account_txs: daoVotes.filter(v => body.account_id === DAO && v.height >= (body.from_tx_block_height ?? 0))
          .map(v => ({ transaction_hash: v.hash })), resume_token: null });
      if (url.pathname === '/fastnear/v0/transactions')
        return json(res, { transactions: daoVotes.filter(v => body.tx_hashes.includes(v.hash)).map(v => ({ receipts: [{ execution_outcome: { outcome: { status: {
          SuccessValue: Buffer.from(JSON.stringify({ scheme: 'Ed25519', signature: [...v.signature] })).toString('base64') } } } }] })) });
      if (url.pathname === '/chain' && body.method === 'status')
        return json(res, { jsonrpc: '2.0', id: body.id, result: { version: { version: 'local', build: 'local' }, chain_id: 'mainnet',
          genesis_hash: '11111111111111111111111111111111', protocol_version: 1, latest_protocol_version: 1, rpc_addr: 'local', node_public_key: PUBLIC_KEY,
          node_key: null, validator_account_id: null, validator_public_key: null, validators: [],
          sync_info: { latest_block_hash: '11111111111111111111111111111111', latest_block_height: height(), latest_state_root: '11111111111111111111111111111111',
            latest_block_time: new Date().toISOString(), syncing: false } } });
      if (url.pathname === '/chain') {
        const { params, id: requestId } = body;
        if (params.request_type === 'view_access_key' && [account, ...payees, ...accounts].includes(params.account_id) && params.public_key === PUBLIC_KEY)
          return json(res, { jsonrpc: '2.0', id: requestId, result: { nonce: 1, permission: 'FullAccess', block_height: 1, block_hash: '11111111111111111111111111111111' } });
        // The simulated DAO: its policy, no proposals yet, and the MPC key its agents are owned by.
        const view = result => json(res, { jsonrpc: '2.0', id: requestId, result: { result: [...Buffer.from(JSON.stringify(result))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } });
        if (dao && params.request_type === 'call_function' && params.account_id === DAO) {
          if (params.method_name === 'get_policy') return view(daoPolicy);
          if (params.method_name === 'get_last_proposal_id') return view(0);
          if (params.method_name === 'get_proposals') return view([]);
        }
        if (dao && params.request_type === 'call_function' && params.account_id === 'v1.signer' && params.method_name === 'derived_public_key') return view(PUBLIC_KEY);
        if (params.request_type === 'call_function' && params.method_name === 'get_policy' && [account, ...payees, ...accounts].includes(params.account_id))
          return json(res, { jsonrpc: '2.0', id: requestId, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: params.account_id } }, code: -32000, message: 'Server error' } });
        // Account existence and balances for the owner's linked account (treasury/link, treasury/get).
        const known = [account, ...payees, ...accounts, ...(dao ? [DAO] : [])];
        if (params.request_type === 'view_account')
          return json(res, known.includes(params.account_id)
            ? { jsonrpc: '2.0', id: requestId, result: { amount: '1000000000000000000000000', locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 100, storage_paid_at: 0, block_height: 1, block_hash: '11111111111111111111111111111111' } }
            : { jsonrpc: '2.0', id: requestId, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: params.account_id } }, code: -32000, message: 'Server error' } });
        if (params.request_type === 'call_function' && params.method_name === 'ft_balance_of')
          return json(res, { jsonrpc: '2.0', id: requestId, result: { result: [...Buffer.from(JSON.stringify('0'))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } });
        // Token registration (NEP-145) for a withdrawal's recipient: the declared accounts are registered on every token.
        if (params.request_type === 'call_function' && params.method_name === 'storage_balance_of') {
          const { account_id } = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
          return view(known.includes(account_id) ? { total: '1250000000000000000000', available: '0' } : null);
        }
        throw new Error(`Undeclared chain request: ${JSON.stringify(params)}`);
      }
      if (unavailable) { outageRefusals++; return json(res, { error: 'Declared local provider outage' }, 503); }
      if (req.method === 'GET' && url.pathname === '/v1/tokens' && observationGate && swaps.length === 1) {
        const gate = observationGate; gate.reached = true; await gate.wait; observationGate = undefined;
      }
      const scoped = url.pathname.match(/^\/v1\/agents\/([0-9a-f]{64})(\/.*)?$/), agent = scoped && agents.get(scoped[1]), route = scoped?.[2] ?? '';
      if (scoped && !agent) return json(res, { error: 'agent_not_found' }, 404);
      if (req.method === 'GET') {
        const base = `/v1/agents/${id}`;
        if (agent && route === '') return json(res, { id: agent.id, status: 'ACTIVE', archived: false, deleted: false, owner: agent.owner, wallet: agent.wallet });
        if (agent && route === '/wallet') return json(res, agent.wallet);
        if (agent && route === '/grants') return json(res, { data: agent.grants });
        if (agent && route === '/policy') return json(res, { policy: agent.policy, revision: agent.revision ?? 1, status: 'APPLIED', provider_policy_synced: true, wallet_id: agent.wallet.wallet_id, policy_hash: null, applied_at: null, transaction_hash: null,
          cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
          // An uncapped window reports every field null, as the provider does since its API #51.
          usage: { budget: Object.fromEntries(['daily', 'weekly', 'monthly'].map(window => { const limit = agent.policy.budget[`${window}_usd`];
            return [window, limit === null ? { limit_usd: null, spent_usd: null, remaining_usd: null, resets_at: null }
              : { limit_usd: limit, spent_usd: '0', remaining_usd: limit, resets_at: null }]; })), timelock: { delay_ms: 0, scheduled_count: 0 } } });
        if (agent && route === '/policy/history') return json(res, { data: [], next_cursor: null });
        if (agent && route === '/balances') return json(res, { near_account_id: agent.wallet.near_account_id, source: url.searchParams.get('source'),
          balances: agent.treasury ? [...agent.treasury[url.searchParams.get('source') === 'public' ? 'public' : 'confidential']].map(([asset_id, balance]) => ({ asset_id, balance_raw: balance.toString() }))
            : [{ asset_id: USDC, balance_raw: url.searchParams.get('source') === 'public' ? '0' : (agent.funded - spent(agent)).toString() }] });
        if (url.pathname === '/v1/tokens') return json(res, { data: TOKENS.map(token => ({ ...token, price_updated_at: new Date().toISOString(), price_expires_at: expires })) });
        // Provider records (ledger audit trail): none recorded by this simulator.
        if (agent && /^\/provider\/(requests|audit|deposits|deposit_history)$/.test(route)) return json(res, { data: { events: [] } });
        // Transfers, withdrawals and swaps, oldest first. A swap's row carries its request and `amount_out` in `details`, as the
        // provider SDK's `ExecutionDetails` declares them (0.7.3 types; a swap row is not observed here).
        if (agent && route === '/history') return json(res, { data: [...transfers.filter(p => p.agent === agent.id).map(status),
          ...swaps.filter(s => s.agent === agent.id).map(swapStatus)].sort((a, b) => a.created_at.localeCompare(b.created_at)), next_cursor: null });
        if (url.pathname === '/v1/status') {
          const correlation = url.searchParams.get('correlation_id');
          const payment = transfers.find(p => p.correlation === correlation);
          if (payment) return json(res, status(payment));
          const swap = swaps.find(s => s.correlation_id === correlation);
          if (swap) return json(res, swapStatus(swap));
          const shield = shields.find(s => s.correlation_id === correlation);
          if (shield) return json(res, { correlation_id: correlation, agent_id: shield.agent, type: 'shield', status: 'SUCCESS' });
          const intent = intents.find(i => i.correlation_id === correlation);
          if (intent && ownerOutcomeUnavailable) return json(res, { error: 'Local scenario withholds owner outcome' }, 503);
          if (intent) return json(res, { correlation_id: correlation, agent_id: intent.created ?? intent.agent?.id ?? id, type: intent.type, status: intent.submitted ? 'SUCCESS' : 'PENDING_SIGNATURE',
            ...(intent.created && { details: { agent_id: intent.created, revision: null, policy_hash: null, transaction_hash: null } }) });
        }
        const payment = agent && transfers.find(p => p.agent === agent.id && route === `/approvals/${p.approval}`);
        if (payment) return json(res, approval(payment));
      }
      if (agent?.treasury && req.method === 'POST' && route === '/swap') {
        if (!liveGrant(agent, req.headers['x-grant-token'])) throw new Error('Missing swap grant');
        const treasuryBalances = agent.treasury.confidential;
        const from = TOKENS.find(t => t.asset_id === body.origin_asset), to = TOKENS.find(t => t.asset_id === body.destination_asset);
        if (!from || !to || from === to || body.confidential !== true || !/^[1-9]\d*$/.test(body.amount)) throw new Error('Unexpected offline swap terms');
        const amountOut = convert(from, to, BigInt(body.amount));
        if (amountOut === 0n) throw new Error('Swap too small to quote');
        if (body.dry) return json(res, { quote: { amount_out: amountOut.toString(), min_amount_out: (amountOut * 999n / 1000n).toString() }, warnings: quoteWarnings.map(code => ({ code, detail: 'simulated' })) });
        if (!entry.key || swaps.some(s => s.key === entry.key)) throw new Error('Missing or repeated swap identity');
        if (BigInt(body.amount) > treasuryBalances.get(from.asset_id) || BigInt(body.min_amount_out) > amountOut) throw new Error('Infeasible swap');
        treasuryBalances.set(from.asset_id, treasuryBalances.get(from.asset_id) - BigInt(body.amount));
        treasuryBalances.set(to.asset_id, treasuryBalances.get(to.asset_id) + amountOut);
        const swap = { correlation_id: randomUUID(), agent: agent.id, key: entry.key, body, amountOut: amountOut.toString(), at: new Date().toISOString() }; swaps.push(swap);
        if (swaps.length === dropSwapAt) { dropSwapAt = 0; return res.destroy(); }
        return json(res, { correlation_id: swap.correlation_id });
      }
      // A public balance moved into the confidential one: what a sweep (or a swap's shortfall) sends.
      if (agent?.treasury && req.method === 'POST' && route === '/shield') {
        if (!liveGrant(agent, req.headers['x-grant-token'])) throw new Error('Missing shield grant');
        const { confidential: treasuryBalances, public: publicBalances } = agent.treasury;
        if (!entry.key || shields.some(s => s.key === entry.key)) throw new Error('Missing or repeated shield identity');
        if (!publicBalances.has(body.asset) || !/^[1-9]\d*$/.test(body.amount) || BigInt(body.amount) > publicBalances.get(body.asset)) throw new Error('Infeasible shield');
        publicBalances.set(body.asset, publicBalances.get(body.asset) - BigInt(body.amount));
        treasuryBalances.set(body.asset, treasuryBalances.get(body.asset) + BigInt(body.amount));
        const shield = { correlation_id: randomUUID(), agent: agent.id, key: entry.key, body }; shields.push(shield);
        return json(res, { correlation_id: shield.correlation_id });
      }
      if (agent && req.method === 'POST' && route === '/deposit') {
        if (body.origin_asset !== USDC || body.confidential !== true || !entry.key) throw new Error('Unexpected deposit request');
        const deposit = { agent: agent.id, key: entry.key, correlation_id: randomUUID() }; deposits.push(deposit);
        return json(res, { correlation_id: deposit.correlation_id, details: { deposit_address: agent.wallet.near_account_id, memo: null, min_amount: '1' } });
      }
      if (agent && req.method === 'POST' && route === '/transfer') {
        if (!liveGrant(agent, req.headers['x-grant-token']) || !entry.key) throw new Error('Missing grant or operation identity');
        const allowed = agent.policy.destinations.list.some(d => d.action === 'transfer' && d.address === body.recipient && d.confidential);
        if (!allowed || body.asset !== USDC || body.confidential !== true) throw new Error('Unexpected transfer terms');
        if (BigInt(body.amount) > BigInt(agent.policy.limits.per_transaction[USDC]) || BigInt(body.amount) > agent.funded - spent(agent)) throw new Error('Transfer exceeds policy limit or funded balance');
        const payment = { agent: agent.id, body, key: entry.key, correlation: randomUUID(), approval: randomUUID(), status: 'PENDING_APPROVAL', at: new Date().toISOString() };
        transfers.push(payment);
        if (dropNextTransfer) { dropNextTransfer = false; return res.destroy(); }
        return json(res, { correlation_id: payment.correlation });
      }
      // A withdrawal to chain near from the confidential balance, held for the owner like a transfer.
      if (agent && req.method === 'POST' && route === '/withdraw') {
        if (!liveGrant(agent, req.headers['x-grant-token']) || !entry.key) throw new Error('Missing grant or operation identity');
        const allowed = agent.policy.actions.includes('withdraw') && agent.policy.destinations.list.some(d => d.action === 'withdraw' && d.chain === 'near' && d.address === body.recipient && d.memo === null);
        if (!allowed || body.asset !== USDC || body.chain !== 'near' || body.confidential !== true || body.memo !== undefined) throw new Error('Unexpected withdrawal terms');
        if (BigInt(body.amount) > BigInt(agent.policy.limits.per_transaction[USDC]) || BigInt(body.amount) > agent.funded - spent(agent)) throw new Error('Withdrawal exceeds policy limit or funded balance');
        const payment = { type: 'withdraw', agent: agent.id, body, key: entry.key, correlation: randomUUID(), approval: randomUUID(), status: 'PENDING_APPROVAL', at: new Date().toISOString() };
        transfers.push(payment);
        return json(res, { correlation_id: payment.correlation });
      }
      if (req.method === 'POST' && url.pathname === '/v1/generate-intent') {
        // A Treasury agent's grant: plain `treasury`, or bound to a saved strategy (`treasury:<suffix>`).
        const strategyTarget = body.type === 'grant_issue' && agents.get(body.agent_id);
        if (strategyTarget?.treasury) {
          if (!/^treasury(:[0-9a-f]{32})?$/.test(body.label) || !body.credential || !body.expires_at) throw new Error('Unexpected Treasury grant');
          const generated = { correlation_id: randomUUID(), type: 'grant_issue', signer: strategyTarget.owner, expires_at: expires,
            intent: { standard: 'nep413', payload: { message: JSON.stringify(body), nonce: randomBytes(32).toString('base64'), recipient: 'local-provider' } },
            preview: { summary: body.label === 'treasury' ? 'Authorize the local Treasury agent' : 'Authorize the saved local strategy' } };
          intents.push({ ...generated, agent: strategyTarget, grantRequest: body }); return json(res, generated);
        }
        const nep413 = () => ({ standard: 'nep413', payload: { message: JSON.stringify(body), nonce: randomBytes(32).toString('base64'), recipient: 'local-provider' } });
        if (body.type === 'agent_create') {
          // The simulated DAO's derived account may own a created agent too: a DAO's setup through an app.
          if (![account, ...(dao ? [DAO_SIGNER] : [])].includes(body.owner?.account_id) || body.owner.public_key !== PUBLIC_KEY || !body.policy) throw new Error('Unexpected agent creation');
          const generated = { correlation_id: randomUUID(), type: 'agent_create', signer: body.owner, expires_at: expires, intent: nep413(), preview: { summary: `Create the local agent "${body.name}"` } };
          intents.push({ ...generated, createRequest: body }); return json(res, generated);
        }
        if (body.type === 'agent_freeze' || body.type === 'agent_unfreeze') {
          const target = agents.get(body.agent_id);
          if (!target) throw new Error('Unexpected agent control');
          const intent = onChainPolicyEdits ? delegate(body.type === 'agent_freeze' ? 'freeze_wallet' : 'unfreeze_wallet', { wallet_pubkey: PUBLIC_KEY }) : nep413();
          const generated = { correlation_id: randomUUID(), type: body.type, signer: target.owner, expires_at: expires, intent,
            preview: { summary: `${body.type === 'agent_freeze' ? 'Freeze' : 'Unfreeze'} the local agent` } };
          intents.push({ ...generated, agent: target, control: body.type }); return json(res, generated);
        }
        // An owner-signed policy change, as the owner's review bound it: the agent's current revision and the full policy.
        if (body.type === 'policy_update') {
          const target = agents.get(body.agent_id);
          if (!target || body.expected_revision !== (target.revision ?? 1) || !body.policy) throw new Error('Unexpected policy update');
          const onChain = onChainPolicyEdits && PROVIDER_FIELDS.some(field => JSON.stringify(body.policy[field]) !== JSON.stringify(target.policy[field]));
          const intent = onChain ? delegate('store_wallet_policy', { wallet_pubkey: PUBLIC_KEY, encrypted_data: randomBytes(64).toString('base64') }) : nep413();
          const generated = { correlation_id: randomUUID(), type: 'policy_update', signer: target.owner, expires_at: expires, intent,
            preview: { summary: 'Change the local agent policy', previous_revision: target.revision ?? 1, revision: (target.revision ?? 1) + 1, policy: body.policy } };
          intents.push({ ...generated, agent: target, policyUpdate: body }); return json(res, generated);
        }
        // An owner's revocation of one of the agent's live grants (NEP-413, per the provider's docs).
        if (body.type === 'grant_revoke') {
          const target = agents.get(body.agent_id), revoked = target?.grants.find(g => g.grant_id === body.grant_id);
          if (!revoked || revoked.revoked_at) throw new Error('Unexpected grant revocation');
          const generated = { correlation_id: randomUUID(), type: 'grant_revoke', signer: target.owner, expires_at: expires, intent: nep413(),
            preview: { summary: `Revoke the local grant "${revoked.label}"` } };
          intents.push({ ...generated, agent: target, revoked }); return json(res, generated);
        }
        if (body.type === 'grant_issue') {
          const target = agents.get(body.agent_id);
          if (!target || target.id === id || body.label !== 'invoices' || !body.credential || !body.expires_at) throw new Error('Unexpected work order grant');
          const generated = { correlation_id: randomUUID(), type: 'grant_issue', signer: target.owner, expires_at: expires, intent: nep413(), preview: { summary: 'Authorize the local work order payout' } };
          intents.push({ ...generated, agent: target, grantRequest: body }); return json(res, generated);
        }
        const payment = transfers.find(p => p.approval === body.approval_id);
        if (body.type !== 'approval_vote' || !['approve', 'reject'].includes(body.verdict) || !payment || payment.agent !== body.agent_id) throw new Error('Unexpected owner request');
        const generated = { correlation_id: randomUUID(), type: 'approval_vote', signer: agents.get(payment.agent).owner, expires_at: expires, intent: nep413(),
          preview: { summary: `${body.verdict === 'approve' ? 'Approve' : 'Reject'} the local test payout`, approval: { ...approval(payment), verdict: body.verdict } } };
        intents.push({ ...generated, payment, agent: agents.get(payment.agent) }); return json(res, generated);
      }
      if (req.method === 'POST' && url.pathname === '/v1/submit-intent') {
        const intent = intents.find(i => i.correlation_id === body.correlation_id);
        if (!intent || intent.submitted) throw new Error('Unknown or repeated owner submission');
        intent.submitted = true;
        if (intent.control) intent.agent.policy.frozen = intent.control === 'agent_freeze';
        else if (intent.policyUpdate) {
          if (intent.policyUpdate.expected_revision !== (intent.agent.revision ?? 1)) throw new Error('Policy update against a stale revision');
          intent.agent.policy = intent.policyUpdate.policy; intent.agent.revision = (intent.agent.revision ?? 1) + 1;
        }
        else if (intent.createRequest) {
          const created = randomBytes(32).toString('hex'), n = agents.size;
          agents.set(created, { id: created, owner: intent.createRequest.owner, policy: intent.createRequest.policy, grants: [], funded: 0n,
            wallet: { wallet_id: `local-wallet-${n}`, near_account_id: `work-${n}.local-wallet.near` },
            ...(intent.createRequest.policy.actions.includes('swap') && { treasury: treasuryState() }) });
          intent.created = created;
        } else if (intent.revoked) {
          // The reason's wording is not observed; only `revoked_at` decides whether a grant is live.
          Object.assign(intent.revoked, { revoked_at: new Date().toISOString(), revoked_reason: 'owner' });
        } else if (intent.grantRequest) {
          const request = intent.grantRequest, target = intent.agent;
          target.grants.push({ ...grant, grant_id: randomUUID(), agent_id: target.id, wallet_id: target.wallet.wallet_id, label: request.label, issued_at: new Date().toISOString(), expires_at: request.expires_at, revoked_at: null, revoked_reason: null,
            owner_message: { ...grant.owner_message, agent_id: target.id, wallet_id: target.wallet.wallet_id, owner: target.owner, label: request.label, credential: request.credential, expires_at_ms: Date.parse(request.expires_at) } });
        } else if (JSON.parse(intent.intent.payload.message).verdict === 'reject') {
          // Assumption, not observed provider behaviour: a rejected held payout ends FAILED and moves nothing.
          Object.assign(intent.payment, { status: 'FAILED', failure: 'rejected_by_owner' });
        } else intent.payment.status = 'PROCESSING';
        if (dropNextSignature) { dropNextSignature = false; return res.destroy(); }
        return json(res, { correlation_id: intent.correlation_id, status: 'SUCCESS' });
      }
      throw new Error(`Undeclared provider request: ${req.method} ${url.pathname}`);
    } catch (error) { errors.push(String(error)); json(res, { error: String(error) }, 500); }
  });
  const port = await listen(server);
  return { id, token: credential.token, url: `http://127.0.0.1:${port}`, requests, errors, transfers, intents, grants, swaps, shields, deposits,
    /** Agents the owner created through signed `agent_create`, in creation order. */
    created: () => [...agents.keys()].filter(agent => agent !== id),
    /** Simulated inbound USDC deposit to a created agent's confidential balance. Not a provider observation of a real transfer. */
    fund(agent, amount) {
      const target = agents.get(agent); if (!target || target.id === id) throw new Error('Fund only a created agent');
      if (target.treasury) target.treasury.confidential.set(USDC, target.treasury.confidential.get(USDC) + BigInt(amount));
      else target.funded += BigInt(amount);
    },
    /** Simulated inbound deposit to the payout agent's own confidential balance (its one-time setup funding). */
    fundPayout(amount) { agents.get(id).funded += BigInt(amount); },
    /** Simulated funds arriving on a Treasury agent's public balance, outside a confidential deposit: a sweep shields them. */
    fundPublic(asset, amount, agent = id) {
      const balances = agents.get(agent)?.treasury?.public;
      if (!balances) throw new Error('Only a Treasury agent has a simulated public balance');
      if (!balances.has(asset) || !/^[1-9]\d*$/.test(String(amount))) throw new Error('Give a listed asset and a positive raw amount');
      balances.set(asset, balances.get(asset) + BigInt(amount));
    },
    /** The warning codes every dry swap quote carries from now on, as the provider's dry run reports them (`[]` clears). */
    warnQuotes(codes) { quoteWarnings = [...codes]; },
    /**
     * The simulated DAO passes a proposal calling `v1.signer` for `hash` (hex): its MPC key, here the test key, signs it,
     * and the receipt is found by FastNEAR's transaction API from the next block on.
     */
    daoVote(hash) {
      const signature = Buffer.from(parseKey(TEST_KEY).sign(Buffer.from(hash, 'hex')).data);
      daoVotes.push({ hash: randomBytes(32).toString('hex'), signature, height: height() + 1 });
    },
    /** A Treasury agent's confidential balances (for assertions). */
    treasuryBalances: (agent = id) => Object.fromEntries([...agents.get(agent).treasury.confidential].map(([asset, raw]) => [asset, raw.toString()])),
    /** The payout agent's current policy and revision (for assertions). */
    payoutPolicy: (agentId = id) => ({ policy: agents.get(agentId).policy, revision: agents.get(agentId).revision }),
    setUnavailable(value) { unavailable = value; },
    /** Provider requests refused by a declared outage: the witness that a call reached the provider. */
    outageRefusals: () => outageRefusals,
    dropSwapResponse(after = 1) { dropSwapAt = swaps.length + after; },
    /** A listed token's USD price, as `/v1/tokens` reports it and every quote converts by: a price move. */
    setPrice(asset, price) {
      const token = TOKENS.find(t => t.asset_id === asset);
      if (!token || typeof price !== 'number' || !fraction(price)) throw new Error('Give a listed asset and a positive decimal price');
      token.price = price;
    },
    pauseObservationAfterFirstSwap() {
      let release; const wait = new Promise(resolve => { release = resolve; });
      observationGate = { wait, release, reached: false }; return observationGate;
    },
    dropTransferResponse() { dropNextTransfer = true; },
    dropSignatureResponse() { dropNextSignature = true; ownerOutcomeUnavailable = true; },
    revealOwnerOutcome() { ownerOutcomeUnavailable = false; }, settle(correlation) {
      const payment = correlation ? transfers.find(p => p.correlation === correlation) : transfers[0];
      if (!payment || payment.status !== 'PROCESSING') throw new Error('Not approved'); payment.status = 'SUCCESS';
    },
    close: () => new Promise(resolve => server.close(resolve)) };
}
