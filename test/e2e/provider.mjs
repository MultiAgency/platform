import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createGrantCredential, grantCommitment } from '@near-intents-agent-api/sdk';
import { Near, parseKey } from 'near-kit';
import { rawKey } from '../../src/nep413.ts';

// Generated for each local environment. Never load application credentials or funded keys.
export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const OWNER = 'owner.near', PAYEE = 'payee.near';
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
const daoPolicy = { proposal_bond: '100000000000000000000000', default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] }, roles: [
  { name: 'council', kind: { Group: [OWNER] }, permissions: ['*:AddProposal', '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize'], vote_policy: {} },
  { name: 'members', kind: { Group: [SECOND] }, permissions: ['call:VoteApprove', 'call:VoteReject'], vote_policy: {} },
] };
export async function sign(account, payload) {
  const near = new Near({ network: 'mainnet', privateKey: TEST_KEY, defaultSignerId: account });
  return { accountId: account, ...await near.signMessage({ ...payload, nonce: Buffer.from(payload.nonce, 'base64') }) };
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
 * `onChainPolicyEdits`: a policy update that changes a provider-enforced field comes back as a NEP-366 delegate carrying
 * an opaque payload, per the provider's docs (not observed here); by default every owner intent is NEP-413.
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
  // The configured agent plus any the owner creates (work orders). Each keeps its own policy, grants and funding.
  const agents = new Map([[id, { id, owner, wallet, policy, revision: 1, grants, funded: BigInt(payoutFunding) }]]);
  const requests = [], errors = [], transfers = [], intents = [], swaps = [], deposits = [];
  const spent = agent => transfers.filter(p => p.agent === agent.id && p.status === 'SUCCESS').reduce((sum, p) => sum + BigInt(p.body.amount), 0n);
  const liveGrant = (agent, token) => typeof token === 'string' && agent.grants.some(g => !g.revoked_at && Date.parse(g.expires_at) > Date.now() && g.owner_message.credential === grantCommitment(token));
  const treasuryBalances = new Map([[USDC, 100000000n], ['nep141:wrap.near', 0n], ['nep141:eth.omft.near', 0n]]);
  if (treasury) { grant.label = 'treasury'; grant.owner_message.label = 'treasury'; }
  let unavailable = false, outageRefusals = 0;
  let dropSwapAt = 0, observationGate;

  const status = payment => ({ correlation_id: payment.correlation, agent_id: payment.agent, type: 'transfer', status: payment.status,
    created_at: payment.at, updated_at: payment.at, failure_code: payment.failure ?? null, details: { approval_id: payment.approval } });
  const approval = payment => {
    const data = { amount: payment.body.amount, chain: 'near', flow: 'transfer', kind: 'confidential', to: payment.body.recipient, token: payment.body.asset };
    return { approval_id: payment.approval, wallet_id: agents.get(payment.agent).wallet.wallet_id, status: payment.status === 'PENDING_APPROVAL' ? 'PENDING' : payment.failure === 'rejected_by_owner' ? 'REJECTED' : 'APPROVED',
      expires_at: expires, request_type: 'confidential', request_data: data,
      request_hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
  };
  let dropNextTransfer = false, dropNextSignature = false, ownerOutcomeUnavailable = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local'), body = await bodyOf(req);
      const entry = { method: req.method, path: url.pathname, query: url.search, body, key: req.headers['idempotency-key'] };
      requests.push(entry); appendFileSync(`${directory}/provider.jsonl`, JSON.stringify(entry) + '\n');
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
          usage: { budget: Object.fromEntries(['daily', 'weekly', 'monthly'].map(window => [window, { limit_usd: agent.policy.budget[`${window}_usd`], spent_usd: '0', remaining_usd: agent.policy.budget[`${window}_usd`], resets_at: null }])), timelock: { delay_ms: 0, scheduled_count: 0 } } });
        if (agent && route === '/policy/history') return json(res, { data: [], next_cursor: null });
        if (agent && route === '/balances') return json(res, { near_account_id: agent.wallet.near_account_id, source: url.searchParams.get('source'),
          balances: treasury && agent.id === id ? [...treasuryBalances].map(([asset_id, balance]) => ({ asset_id, balance_raw: url.searchParams.get('source') === 'public' ? '0' : balance.toString() }))
            : [{ asset_id: USDC, balance_raw: url.searchParams.get('source') === 'public' ? '0' : (agent.funded - spent(agent)).toString() }] });
        if (url.pathname === '/v1/tokens') return json(res, { data: [
          { asset_id: USDC, symbol: 'USDC', decimals: 6, price: 1 },
          { asset_id: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, price: 2 },
          { asset_id: 'nep141:eth.omft.near', symbol: 'ETH', decimals: 18, price: 2000 },
        ].map(token => ({ ...token, price_updated_at: new Date().toISOString(), price_expires_at: expires })) });
        // Provider records (ledger audit trail): none recorded by this simulator.
        if (agent && /^\/provider\/(requests|audit|deposits|deposit_history)$/.test(route)) return json(res, { data: { events: [] } });
        if (agent && route === '/history') return json(res, { data: transfers.filter(p => p.agent === agent.id).map(status), next_cursor: null });
        if (url.pathname === '/v1/status') {
          const correlation = url.searchParams.get('correlation_id');
          const payment = transfers.find(p => p.correlation === correlation);
          if (payment) return json(res, status(payment));
          const swap = swaps.find(s => s.correlation_id === correlation);
          if (swap) return json(res, { correlation_id: correlation, agent_id: id, type: 'swap', status: 'SUCCESS' });
          const intent = intents.find(i => i.correlation_id === correlation);
          if (intent && ownerOutcomeUnavailable) return json(res, { error: 'Local scenario withholds owner outcome' }, 503);
          if (intent) return json(res, { correlation_id: correlation, agent_id: intent.created ?? intent.agent?.id ?? id, type: intent.type, status: intent.submitted ? 'SUCCESS' : 'PENDING_SIGNATURE',
            ...(intent.created && { details: { agent_id: intent.created, revision: null, policy_hash: null, transaction_hash: null } }) });
        }
        const payment = agent && transfers.find(p => p.agent === agent.id && route === `/approvals/${p.approval}`);
        if (payment) return json(res, approval(payment));
      }
      if (treasury && req.method === 'POST' && url.pathname === `/v1/agents/${id}/swap`) {
        if (!liveGrant(agents.get(id), req.headers['x-grant-token'])) throw new Error('Missing swap grant');
        if (body.origin_asset !== USDC || body.destination_asset !== 'nep141:wrap.near' || body.confidential !== true) throw new Error('Unexpected offline swap terms');
        const amountOut = BigInt(body.amount) * 500000000000000000n;
        if (body.dry) return json(res, { quote: { amount_out: amountOut.toString(), min_amount_out: (amountOut * 999n / 1000n).toString() } });
        if (!entry.key || swaps.some(s => s.key === entry.key)) throw new Error('Missing or repeated swap identity');
        if (BigInt(body.amount) > treasuryBalances.get(USDC) || BigInt(body.min_amount_out) > amountOut) throw new Error('Infeasible swap');
        treasuryBalances.set(USDC, treasuryBalances.get(USDC) - BigInt(body.amount));
        treasuryBalances.set('nep141:wrap.near', treasuryBalances.get('nep141:wrap.near') + amountOut);
        const swap = { correlation_id: randomUUID(), key: entry.key, body }; swaps.push(swap);
        if (swaps.length === dropSwapAt) { dropSwapAt = 0; return res.destroy(); }
        return json(res, { correlation_id: swap.correlation_id });
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
      if (req.method === 'POST' && url.pathname === '/v1/generate-intent') {
        if (treasury && body.type === 'grant_issue') {
          if (body.agent_id !== id || !body.label.startsWith('treasury:') || !body.credential) throw new Error('Unexpected strategy grant');
          const generated = { correlation_id: randomUUID(), type: 'grant_issue', signer: owner, expires_at: expires,
            intent: { standard: 'nep413', payload: { message: JSON.stringify(body), nonce: randomBytes(32).toString('base64'), recipient: 'local-provider' } },
            preview: { summary: 'Authorize the saved local strategy' } };
          intents.push({ ...generated, grantRequest: body }); return json(res, generated);
        }
        const nep413 = () => ({ standard: 'nep413', payload: { message: JSON.stringify(body), nonce: randomBytes(32).toString('base64'), recipient: 'local-provider' } });
        if (body.type === 'agent_create') {
          if (body.owner?.account_id !== account || body.owner.public_key !== PUBLIC_KEY || !body.policy) throw new Error('Unexpected agent creation');
          const generated = { correlation_id: randomUUID(), type: 'agent_create', signer: body.owner, expires_at: expires, intent: nep413(), preview: { summary: `Create the local agent "${body.name}"` } };
          intents.push({ ...generated, createRequest: body }); return json(res, generated);
        }
        if (body.type === 'agent_freeze' || body.type === 'agent_unfreeze') {
          const target = agents.get(body.agent_id);
          if (!target) throw new Error('Unexpected agent control');
          const generated = { correlation_id: randomUUID(), type: body.type, signer: target.owner, expires_at: expires, intent: nep413(),
            preview: { summary: `${body.type === 'agent_freeze' ? 'Freeze' : 'Unfreeze'} the local agent` } };
          intents.push({ ...generated, agent: target, control: body.type }); return json(res, generated);
        }
        // An owner-signed policy change, as the owner's review bound it: the agent's current revision and the full policy.
        if (body.type === 'policy_update') {
          const target = agents.get(body.agent_id);
          if (!target || body.expected_revision !== (target.revision ?? 1) || !body.policy) throw new Error('Unexpected policy update');
          const onChain = onChainPolicyEdits && PROVIDER_FIELDS.some(field => JSON.stringify(body.policy[field]) !== JSON.stringify(target.policy[field]));
          const delegate = { standard: 'nep366', payload: { receiverId: 'outlayer.near', actions: [{ type: 'FunctionCall', params: { methodName: 'store_wallet_policy',
            args: { wallet_pubkey: PUBLIC_KEY, encrypted_data: randomBytes(64).toString('base64') }, gas: '30000000000000', deposit: '0' } }] } };
          const generated = { correlation_id: randomUUID(), type: 'policy_update', signer: target.owner, expires_at: expires, intent: onChain ? delegate : nep413(),
            preview: { summary: 'Change the local agent policy', previous_revision: target.revision ?? 1, revision: (target.revision ?? 1) + 1, policy: body.policy } };
          intents.push({ ...generated, agent: target, policyUpdate: body }); return json(res, generated);
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
            wallet: { wallet_id: `local-wallet-${n}`, near_account_id: `work-${n}.local-wallet.near` } });
          intent.created = created;
        } else if (intent.grantRequest) {
          const request = intent.grantRequest, target = intent.agent ?? agents.get(id);
          target.grants.push({ ...grant, grant_id: randomUUID(), agent_id: target.id, wallet_id: target.wallet.wallet_id, label: request.label, expires_at: request.expires_at,
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
  return { id, token: credential.token, url: `http://127.0.0.1:${port}`, requests, errors, transfers, intents, grants, swaps, deposits,
    /** Agents the owner created through signed `agent_create`, in creation order. */
    created: () => [...agents.keys()].filter(agent => agent !== id),
    /** Simulated inbound deposit to an agent's confidential balance. Not a provider observation of a real transfer. */
    fund(agent, amount) { const target = agents.get(agent); if (!target || target.id === id) throw new Error('Fund only a created agent'); target.funded += BigInt(amount); },
    /** Simulated inbound deposit to the payout agent's own confidential balance (its one-time setup funding). */
    fundPayout(amount) { agents.get(id).funded += BigInt(amount); },
    /** The payout agent's current policy and revision (for assertions). */
    payoutPolicy: () => ({ policy: agents.get(id).policy, revision: agents.get(id).revision }),
    setUnavailable(value) { unavailable = value; },
    /** Provider requests refused by a declared outage: the witness that a call reached the provider. */
    outageRefusals: () => outageRefusals,
    dropSwapResponse(after = 1) { dropSwapAt = swaps.length + after; },
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
