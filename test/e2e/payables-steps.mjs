import { expect } from '@playwright/test';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { OWNER, sign } from './provider.mjs';
import { connectWallet } from './wallet.mjs';

// Shared Payables workflow steps on the real stack: the owner's RPC through the gateway session, the payee API
// through the payee's own session, and one owner-signed action. Used by every spec that runs this workflow.

/** The owner's signed-in RPC on the payout agent. */
export async function ownerRpc(page, stack) {
  await page.goto(`${stack.dashboard}/a/payout/`);
  // Signed in on whichever frontend serves the owner's pages: the gateway session names the owner.
  await connectWallet(page, OWNER);
  return (method, input) => page.evaluate(async ({ method, input }) => {
    const response = await fetch(`/a/payout/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
    const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value.json;
  }, { method, input });
}

/** The payee's signed-in API on the invoices host (wallet sign-in in the page). */
export async function payeeApi(page, stack) {
  await page.goto(stack.invoices);
  await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
  const chooser = page.getByText('Local test wallet', { exact: true }); await chooser.waitFor(); await chooser.click();
  await expect(page.getByRole('button', { name: 'Submit invoice', exact: true })).toBeVisible();
  return (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { method, path, body });
}

/**
 * One owner action on one order: prepare, sign the exact prepared intent, submit once, follow its own record.
 * An approval stays open until the payout it releases is final, so it waits only for the accepted signature.
 */
export async function ownerAction(rpc, id, action) {
  const prepared = await rpc('workOrders/prepare', { id, action, signer: 'wallet' });
  const signed = await sign(OWNER, prepared.intent.payload);
  await rpc('workOrders/submit', { id, correlationId: prepared.correlationId, signedData: { ...prepared.intent, public_key: signed.publicKey, signature: signed.signature } });
  if (action === 'approve' || action === 'reject') await expect.poll(async () => (await rpc('workOrders/get', { id })).ownerActions.find(a => a.correlationId === prepared.correlationId)?.ownerSucceeded).toBe(true);
  else await expect.poll(async () => (await rpc('workOrders/status', { id, correlationId: prepared.correlationId })).status).toBe('SUCCESS');
  return prepared.correlationId;
}

/** A fetch for programs outside a browser (agents): no cookies, and the stack's local certificate is accepted. */
export const programFetch = (input, init = {}) => new Promise((resolve, reject) => {
  const target = new URL(input), send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = send(target, { method: init.method ?? 'GET', headers: init.headers ?? {}, rejectUnauthorized: false }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode,
      headers: Object.entries(res.headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(v => [name, String(v)])) })));
  });
  req.on('error', reject); if (init.body !== undefined) req.write(init.body); req.end();
});
