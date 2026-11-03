// E2E only: FastNear's Transfers API reports no public movements, so reconciliation reads run offline, and its
// transaction API answers from the simulated chain (DAO votes).
// Every other request is unchanged and still passes through the offline network guard.
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.host === 'transfers.main.fastnear.com' && url.pathname === '/v0/transfers')
    return new Response(JSON.stringify({ transfers: [], resume_token: null }), { headers: { 'content-type': 'application/json' } });
  // FastNEAR's transaction API (the DAO-signature search) is answered by the stack's simulated chain.
  if (url.host === 'tx.main.fastnear.com' && ['/v0/account', '/v0/transactions'].includes(url.pathname) && process.env.NEAR_RPC_URL)
    return original(new URL(`/fastnear${url.pathname}`, process.env.NEAR_RPC_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: init?.body });
  return original(input, init);
};
