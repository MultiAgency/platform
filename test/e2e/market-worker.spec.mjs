import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { environment } from './environment.mjs';
import { connect, value } from './app-steps.mjs';
import { listen } from './provider.mjs';
import { market } from './market.mjs';

test('the offline market refuses an external webhook target before opening a listener', async () => {
  await expect(market({ agents: { worker: { amount: '500000', windowSeconds: 600, outcome: 'worker' } },
    webhookUrl: 'https://example.com/hook' })).rejects.toThrow('local HTTP loopback');
});

// Two agencies in one offline stack: a buyer's market agent pays a listed self-hosted worker. The worker is a
// separate process boundary with an aat_ token and a signed webhook. It cannot read or submit another worker's hire.
test('a listed worker receives an instant hire and payment settles only on delivery', async ({}, info) => {
  test.setTimeout(240_000);
  const secret = 'whsec_offline_worker_fixture';
  const received = [], unique = new Set();
  const webhook = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks), timestamp = req.headers['x-market-timestamp'];
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
    const actual = Buffer.from((req.headers['x-market-signature'] ?? '').replace(/^sha256=/, ''), 'hex');
    const signed = typeof timestamp === 'string' && Math.abs(Date.now() / 1_000 - Number(timestamp)) <= 300
      && expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!signed) { res.writeHead(401); res.end(); return; }
    const payload = JSON.parse(raw.toString());
    const delivery = req.headers['x-market-delivery'];
    received.push({ event: req.headers['x-market-event'], delivery, payload });
    unique.add(delivery);
    res.writeHead(204); res.end();
  });
  const port = await listen(webhook);
  let stack;
  try {
    stack = await environment(info.outputPath('environment'), { headless: true, secondAccount: true,
      appSetup: ['payables', 'market'], market: {
        worker: { amount: '500000', windowSeconds: 600, outcome: 'worker', name: 'Agency worker' },
        poller: { amount: '600000', windowSeconds: 600, outcome: 'worker', name: 'Polling agency', webhookUrl: null },
      }, marketWebhookUrl: `http://127.0.0.1:${port}/webhook`, marketWebhookSecret: secret });
    const { app, ownerStep, consent, hostedAgent } = await connect(stack);
    const name = await hostedAgent('buyer_org', 'market');
    const created = value(await app.identity(name)).agentId;
    await consent('buyer_org', name, ['owner', 'market', 'read']);
    const buyer = app.agent('buyer_org', name);
    await ownerStep(buyer, { type: 'grant_issue', label: 'market' });
    stack.simulated.fund(created, 10_000_000n);
    const account = value(await buyer.call('market/account'));
    stack.market.register(account.account);

    const directory = await (await fetch(`${stack.market.url}/v1/agents?q=worker`)).json();
    const listed = directory.agents.find(agent => agent.handle === 'worker');
    expect(listed).toMatchObject({ runtime: 'http', listing_status: 'live', availability: 'available' });
    const pollingAgency = (await (await fetch(`${stack.market.url}/v1/agents?q=poller`)).json()).agents[0];
    expect(pollingAgency.owner_account_id, 'a different listed worker belongs to another market account').not.toBe(listed.owner_account_id);
    const pricing = await (await fetch(`${stack.market.url}/v1/agents/${listed.agent_id}/pricing-plans`)).json();
    expect(pricing).toMatchObject([{ model: 'per_call', price_amount: '0.500000', is_default: true }]);
    const reputation = await (await fetch(`${stack.market.url}/v1/agents/${listed.agent_id}/reputation`)).json();
    expect(reputation).toMatchObject({ jobs_counted: 0, overall: null, axes: {} });

    const brief = 'Research brief\nWrite an article on NEAR Intents.';
    const approved = value(await buyer.call('market/quote', { handle: 'worker', brief }));
    const hired = value(await buyer.call('market/hire', { requestId: 'worker-hire', brief, approved }));
    const assignmentId = hired.taskId;
    expect(assignmentId).toBeTruthy();
    expect(stack.market.tasks.get(assignmentId).status.state).toBe('TASK_STATE_WORKING');
    expect(stack.market.chain.accounts.get(account.account).transfers).toHaveLength(0);
    expect(value(await buyer.call('market/status', { requestId: 'worker-hire' })).state).toBe('unknown');

    await expect.poll(() => received.length).toBe(1);
    expect(received[0].event).toBe('hire.created');
    expect(received[0].payload).toMatchObject({ event: 'hire.created', kind: 'instant', assignment_id: assignmentId,
      description: brief, token: 'X402' });
    expect(received[0].payload.mcp.session_token).toMatch(/^mcpbs_/);
    expect(await stack.market.redeliver(assignmentId)).toBe(204);
    expect(received).toHaveLength(2);
    expect(unique.size, 'the worker can deduplicate a retry by delivery ID').toBe(1);

    const worker = stack.market.credentials('worker'), poller = stack.market.credentials('poller');
    expect(worker.token).toMatch(/^aat_/);
    const api = (token, path, options = {}) => fetch(`${stack.market.url}${path}`, {
      ...options, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
    });
    expect((await api('aat_wrong', '/v1/agents/me/assignments?status=all')).status).toBe(401);
    expect((await (await api(poller.token, '/v1/agents/me/assignments?status=all')).json()).assignments).toHaveLength(0);
    const mine = await (await api(worker.token, '/v1/agents/me/assignments?status=all')).json();
    expect(mine.assignments).toHaveLength(1);
    expect(mine.assignments[0]).toMatchObject({ assignment: { assignmentId, status: 'in_progress', escrowToken: 'X402',
      workerAgentId: worker.agentId }, job: { jobKind: 'instant', description: brief } });
    await expect.poll(async () => (await (await api(worker.token, '/v1/agents/me/assignments?status=all')).json())
      .assignments[0].assignment.startedAt).not.toBeNull(); // 2xx webhook is the worker's start.
    const submitPath = `/v1/assignments/${assignmentId}/submit`;
    const body = JSON.stringify({ deliverableMarkdown: '# The article\nDelivered by the worker.' });
    expect((await api(poller.token, submitPath, { method: 'POST', body })).status).toBe(403);
    expect((await api(worker.token, submitPath, { method: 'POST', body: JSON.stringify({ deliverableMarkdown: '' }) })).status).toBe(400);
    expect(stack.market.chain.accounts.get(account.account).transfers).toHaveLength(0);
    const submitted = await (await api(worker.token, submitPath, { method: 'POST', body })).json();
    expect(submitted.status).toBe('submitted');
    expect((await (await api(worker.token, '/v1/agents/me/assignments?status=all')).json()).assignments[0].assignment.status).toBe('accepted');
    await expect.poll(async () => value(await buyer.call('market/status', { requestId: 'worker-hire' })).state, { timeout: 30_000 }).toBe('paid');
    expect(value(await buyer.call('market/status', { requestId: 'worker-hire' })).deliverable).toBe('# The article\nDelivered by the worker.');
    expect(stack.market.chain.accounts.get(account.account).transfers).toHaveLength(1);
    expect((await api(worker.token, submitPath, { method: 'POST', body })).status).toBe(409);
    expect(stack.market.chain.accounts.get(account.account).transfers).toHaveLength(1);

    // Polling without a webhook is a complete worker path. Its token cannot see the first worker's assignment.
    const pollBrief = 'Polling brief\nA second agency delivers without webhooks.';
    const pollTerms = value(await buyer.call('market/quote', { handle: 'poller', brief: pollBrief }));
    const pollHire = value(await buyer.call('market/hire', { requestId: 'poll-hire', brief: pollBrief, approved: pollTerms }));
    expect(received).toHaveLength(2);
    const pollRows = (await (await api(poller.token, '/v1/agents/me/assignments?status=all')).json()).assignments;
    expect(pollRows).toHaveLength(1);
    expect(pollRows[0].assignment).toMatchObject({ assignmentId: pollHire.taskId, startedAt: null });
    expect((await api(poller.token, `/v1/assignments/${pollHire.taskId}/start`, { method: 'POST' })).status).toBe(200);
    const pollSubmit = await (await api(poller.token, `/v1/assignments/${pollHire.taskId}/submit`,
      { method: 'POST', body: JSON.stringify({ deliverableMarkdown: '# Polling result' }) })).json();
    expect(pollSubmit.status).toBe('submitted');
    await expect.poll(async () => value(await buyer.call('market/status', { requestId: 'poll-hire' })).state, { timeout: 30_000 }).toBe('paid');
    expect(stack.market.chain.accounts.get(account.account).transfers).toHaveLength(2);

    // A late deliverable cannot turn an expired payment into a paid result or relay a replacement.
    const lateBrief = 'Late brief\nDeliver after the signed payment expires.';
    const lateTerms = value(await buyer.call('market/quote', { handle: 'poller', brief: lateBrief }));
    const lateHire = value(await buyer.call('market/hire', { requestId: 'late-hire', brief: lateBrief, approved: lateTerms }));
    stack.market.advance(2_000);
    const lateSubmit = await (await api(poller.token, `/v1/assignments/${lateHire.taskId}/submit`,
      { method: 'POST', body: JSON.stringify({ deliverableMarkdown: '# Too late' }) })).json();
    expect(lateSubmit.status).toBe('submitted');
    expect(stack.market.assignments.get(lateHire.taskId).assignment.status).toBe('submitted');
    expect(value(await buyer.call('market/status', { requestId: 'late-hire' })).state).toBe('not_charged');
    expect(stack.market.chain.accounts.get(account.account).transfers).toHaveLength(2);
  } finally {
    await stack?.close();
    await new Promise(resolve => webhook.close(resolve));
  }
});
