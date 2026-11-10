import assert from "node:assert/strict";
import { after, test } from "node:test";
import { decodeSignedDelegateAction, encodeSignedDelegateAction, generateKey } from "near-kit";
import { MARKET_PAYEE, MARKET_USDC, market } from "./e2e/market.mjs";

/**
 * The market's x402 leg offline (docs/market.md): the payee check before anything is signed, the payment key's one
 * shape, and the payment's outcome read from the chain only. The simulated market follows the market's x402-caller
 * skill 0.2.0; it and the chain it serves are this process's, on loopback.
 */

const sim = await market({ agents: {
  writer: { amount: "500000", windowSeconds: 600, outcome: "complete", result: "the article" },
  refuser: { amount: "500000", windowSeconds: 600, outcome: "reject" },
} });
process.env.MARKET_URL = sim.url;
process.env.NEAR_RPC_URL = sim.rpc;
// Read after the environment points at the simulator: chain.ts fixes its RPC endpoint on import.
const { briefDigest, paymentExpiry, paymentHeader, quoteTerms, sameTerms } = await import("../src/market/x402.js");
const { challenge, getTask, message, paidCall, payees } = await import("../src/market/client.js");
const { keySigner } = await import("../src/market/payment-key.js");
const { paymentOutcome, readChainView } = await import("../src/market/resolution.js");

after(() => sim.close());

const BRIEF = "An article\nWrite 300 words on NEAR Intents.";
const HOUR = 3_600;
const challengeFor = (row: object) => ({ x402Version: 2, error: "x-payment header is required", accepts: [row] });
const published = { x402Version: 2, recipients: [{ network: "near:mainnet", asset: MARKET_USDC, payTo: MARKET_PAYEE }] };
// In the order mainnet sends a row's keys (2026-11-09), which `accepted` must repeat.
const row = { amount: "500000", asset: MARKET_USDC, maxTimeoutSeconds: 1_200, network: "near:mainnet", payTo: MARKET_PAYEE, scheme: "exact" };

test("a quote is paid only to the payee the market publishes, in its asset, by the exact scheme", () => {
  const quote = (over: object, handle = "writer") =>
    quoteTerms({ handle, brief: BRIEF, challenge: challengeFor({ ...row, ...over }), payees: published, maxWindowSeconds: HOUR });
  const ok = quote({});
  assert.ok("terms" in ok);
  assert.deepEqual(ok.terms, { handle: "writer", brief: briefDigest(BRIEF), network: "near:mainnet", asset: MARKET_USDC,
    payTo: MARKET_PAYEE, amount: "500000", maxTimeoutSeconds: 1_200 });
  const code = (result: ReturnType<typeof quote>) => "refused" in result ? result.refused.code : "accepted";
  assert.equal(code(quote({ payTo: "attacker.near" })), "payee_not_published");
  assert.equal(code(quote({ asset: "usdt.tether-token.near" })), "payee_not_published");
  assert.equal(code(quote({ scheme: "upto" })), "scheme_not_supported");
  assert.equal(code(quote({ network: "eip155:8453" })), "network_not_offered");
  assert.equal(code(quote({ amount: "0" })), "quote_unreadable");
  assert.equal(code(quote({ maxTimeoutSeconds: HOUR + 1 })), "window_too_long");
  // A handle is one DNS label: anything else could send the call, and the payment, to another host.
  for (const handle of ["evil.com/x", "a.b", "-x", "X", ""]) assert.equal(code(quote({}, handle)), "handle_invalid");
  // Two published payees for the network is no single answer.
  const twice = { ...published, recipients: [...published.recipients, { ...published.recipients[0], payTo: "other.near" }] };
  const both = quoteTerms({ handle: "writer", brief: BRIEF, challenge: challengeFor(row), payees: twice, maxWindowSeconds: HOUR });
  assert.equal(code(both), "payee_not_published");
});

test("approved terms are paid only while a fresh quote equals them", () => {
  const first = quoteTerms({ handle: "writer", brief: BRIEF, challenge: challengeFor(row), payees: published, maxWindowSeconds: HOUR });
  const raised = quoteTerms({ handle: "writer", brief: BRIEF, challenge: challengeFor({ ...row, amount: "600000" }), payees: published, maxWindowSeconds: HOUR });
  const rebriefed = quoteTerms({ handle: "writer", brief: `${BRIEF}!`, challenge: challengeFor(row), payees: published, maxWindowSeconds: HOUR });
  assert.ok("terms" in first && "terms" in raised && "terms" in rebriefed);
  assert.equal(sameTerms(first.terms, { ...first.terms }), true);
  assert.equal(sameTerms(first.terms, raised.terms), false);
  assert.equal(sameTerms(first.terms, rebriefed.terms), false);
});

test("the payment key signs one ft_transfer of the asked amount to the asked payee, without reaching the network", async () => {
  const signer = keySigner(generateKey().secretKey);
  assert.match(signer.account, /^[0-9a-f]{64}$/);
  const signed = await signer.sign({ asset: MARKET_USDC, payTo: MARKET_PAYEE, amount: "500000", nonce: 8n, maxBlockHeight: 2_000n });
  const { delegateAction } = decodeSignedDelegateAction(Buffer.from(signed.signedDelegateAction, "base64")).signedDelegate;
  assert.equal(delegateAction.senderId, signer.account);
  assert.equal(delegateAction.receiverId, MARKET_USDC);
  assert.equal(delegateAction.nonce, 8n);
  assert.equal(delegateAction.maxBlockHeight, 2_000n);
  assert.equal(delegateAction.actions.length, 1);
  const action = delegateAction.actions[0]!;
  assert.ok("functionCall" in action);
  const call = action.functionCall;
  assert.equal(call.methodName, "ft_transfer");
  assert.equal(call.deposit, 1n);
  assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { receiver_id: MARKET_PAYEE, amount: "500000" });
  await assert.rejects(signer.sign({ asset: MARKET_USDC, payTo: MARKET_PAYEE, amount: "0", nonce: 9n, maxBlockHeight: 2_000n }));
});

test("an outcome is the chain's: paid once the transfer lands, not charged once the authorization can't be relayed", () => {
  const signed = { nonce: 5n, maxBlockHeight: 100n, amount: 500n, balanceAtSigning: 700n };
  assert.equal(paymentOutcome(signed, { height: 50n, keyNonce: 5n, balance: 200n }), "paid");
  assert.equal(paymentOutcome(signed, { height: 101n, keyNonce: 4n, balance: 700n }), "not_charged");
  assert.equal(paymentOutcome(signed, { height: 101n, keyNonce: null, balance: 700n }), "not_charged");
  // Still relayable.
  assert.equal(paymentOutcome(signed, { height: 100n, keyNonce: 4n, balance: 700n }), "unknown");
  // Relayed, but the transfer isn't seen: a failed transfer and one still landing look alike.
  assert.equal(paymentOutcome(signed, { height: 50n, keyNonce: 5n, balance: 700n }), "unknown");
  // A balance something else moved.
  assert.equal(paymentOutcome(signed, { height: 50n, keyNonce: 5n, balance: 100n }), "unknown");
  assert.equal(paymentOutcome(signed, { height: 101n, keyNonce: 4n, balance: 900n }), "not_charged");
});

/** One hire against the simulated market, as the executor will run it: quote, sign at the chain's nonce, pay. */
async function hire(handle: string, brief = BRIEF) {
  const signer = keySigner(generateKey().secretKey);
  const params = message(crypto.randomUUID(), brief);
  const quote = quoteTerms({ handle, brief, challenge: await challenge(handle, params), payees: await payees(), maxWindowSeconds: 2 * 86_400 });
  assert.ok("terms" in quote);
  sim.fund(signer.account, quote.terms.amount);
  const view = await readChainView(signer.account, signer.publicKey, MARKET_USDC);
  const signed = { nonce: view.keyNonce! + 1n, maxBlockHeight: paymentExpiry(view.height, quote.terms),
    amount: BigInt(quote.terms.amount), balanceAtSigning: view.balance };
  const payment = await signer.sign({ asset: quote.terms.asset, payTo: quote.terms.payTo, amount: quote.terms.amount,
    nonce: signed.nonce, maxBlockHeight: signed.maxBlockHeight });
  const header = paymentHeader(quote.row, payment.signedDelegateAction);
  const outcome = async () => paymentOutcome(signed, await readChainView(signer.account, signer.publicKey, MARKET_USDC));
  return { signer, params, header, signed, payment, outcome, call: () => paidCall(handle, params, header) };
}

test("a delivered hire is paid, once, and its result read back", async () => {
  const h = await hire("writer");
  const answer = await h.call();
  assert.ok("task" in answer);
  assert.equal(answer.task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(await h.outcome(), "paid");
  assert.equal((await getTask("writer", answer.task.id)).artifacts?.[0]?.parts[0]?.text, "the article");
  // The same header again is refused, and nothing more moves.
  const replay = await h.call();
  assert.ok("status" in replay && replay.status === 402);
  assert.equal(sim.chain.accounts.get(h.signer.account)!.transfers.length, 1);
});

test("a refused hire stays unknown while its authorization could still be relayed, then is not charged", async () => {
  const h = await hire("refuser");
  const answer = await h.call();
  assert.ok("task" in answer && answer.task.status.state === "TASK_STATE_REJECTED");
  assert.equal(await h.outcome(), "unknown");
  sim.advance(h.signed.maxBlockHeight - sim.chain.height + 1n);
  assert.equal(await h.outcome(), "not_charged");
  // Too late for anyone holding it.
  assert.deepEqual(sim.relay(h.payment.signedDelegateAction), { relayed: false, reason: "expired" });
});

test("a payment relayed without a delivery is still a payment", async () => {
  const h = await hire("refuser");
  assert.ok("task" in await h.call());
  assert.deepEqual(sim.relay(h.payment.signedDelegateAction), { relayed: true, transferred: true });
  assert.equal(await h.outcome(), "paid");
});

test("the market refuses a payment valid for the whole window from the final block, which it reads as too long", async () => {
  const h = await hire("writer");
  const whole = await h.signer.sign({ asset: MARKET_USDC, payTo: MARKET_PAYEE, amount: "500000", nonce: h.signed.nonce,
    maxBlockHeight: sim.chain.height + 1_200n });
  const refused = await paidCall("writer", h.params, paymentHeader(row, whole.signedDelegateAction));
  assert.ok("status" in refused && refused.status === 402);
  assert.match(refused.error, /timeout_window_exceeds_max_timeout/);
});

test("the market refuses a payment that expires before the agent's window", async () => {
  const h = await hire("writer");
  const short = await h.signer.sign({ asset: MARKET_USDC, payTo: MARKET_PAYEE, amount: "500000", nonce: h.signed.nonce,
    maxBlockHeight: sim.chain.height + 60n });
  const refused = await paidCall("writer", h.params, paymentHeader({ ...row, maxTimeoutSeconds: 1_200 }, short.signedDelegateAction));
  assert.ok("status" in refused && refused.status === 402);
  assert.match(refused.error, /SLA window/);
});

test("the market refuses a payment whose signature isn't the key's", async () => {
  const h = await hire("writer");
  const decoded = decodeSignedDelegateAction(Buffer.from(h.payment.signedDelegateAction, "base64"));
  const { signature } = decoded.signedDelegate;
  assert.ok("ed25519Signature" in signature);
  signature.ed25519Signature.data[0]! ^= 1;
  const forged = paymentHeader(row, encodeSignedDelegateAction(decoded));
  const refused = await paidCall("writer", h.params, forged);
  assert.ok("status" in refused && refused.status === 402);
  assert.match(refused.error, /signature/);
  assert.equal(sim.chain.accounts.get(h.signer.account)!.transfers.length, 0);
});
