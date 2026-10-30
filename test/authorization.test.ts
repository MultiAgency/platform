import { authorityFixture, fixtureWallet, policyView } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Policy } from "@near-intents-agent-api/sdk";
import { pay } from "../src/agent.js";
import { api } from "../src/api.js";
import { agreed } from "../src/invoices.js";
import { canonical } from "../src/mandate.js";
import { readOps, record } from "../src/ops.js";
import { checkPaymentApproval } from "../src/payment-approval.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { freshDirectory, offline } from "./fixtures/harness.js";
import { createRouterClient, ORPCError } from "@orpc/server";
import { router } from "../src/router.js";

/** Regressions for the single authorization rule (see CONTEXT.md, "Authorization"), through the real money path. */

const usdc = (amount: string, recipient = "payee.near") =>
  ({ asset: ASSETS.USDC, amount, recipient, confidential: true });
let policy: Policy;
let sends: string[];

freshDirectory("authorization");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  policy = payoutPolicy(["payee.near"]);
  sends = [];
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policyView(policy));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  const transfer = async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
    sends.push(idempotencyKey);
    return { correlation_id: `op_${sends.length}` };
  };
  mock.method(api, "forGrant", () => ({ transfer, swap: transfer, shield: transfer, unshield: transfer }));
});
afterEach(() => mock.restoreAll());

/** An `except` policy forbids its listed payees: none of them is agreed. */
const except = (forbidden: string[]): Policy => ({ ...policy, destinations: { ...policy.destinations, mode: "except",
  list: forbidden.map((address) => ({ action: "transfer" as const, address, confidential: true })) } });

const refusedBeforeSending = async (request: ReturnType<typeof usdc>, code: string) => {
  assert.deepEqual(await pay(request), { outcome: "refused", code });
  assert.deepEqual(sends, []);
  assert.equal(readOps().at(-1)?.refused, code);
};

test("a payout without a live grant is refused before sending", async () => {
  mock.method(api, "listGrants", async () => []);
  await refusedBeforeSending(usdc("1"), "grant_missing");
});

test("a payout the wallet can't cover is refused before sending, so it never goes to a vote", async () => {
  // Mainnet, 2026-10-12 (docs/mainnet-log.md, Invoices): the provider held a payout for approval from an empty wallet; it failed after the DAO voted.
  mock.method(api, "getBalances", async () => ({ balances: [] }));
  await refusedBeforeSending(usdc("1"), "insufficient_balance");
});

test("payouts already held for approval count against the balance, so two can't both go to a vote on funds for one", async () => {
  mock.method(api, "getBalances", async () => ({ balances: [{ asset_id: ASSETS.USDC, balance_raw: "1500000" }] }));
  record({ at: new Date().toISOString(), idempotencyKey: "payout:held", kind: "payout", method: "transfer", request: usdc("1000000") });
  record({ idempotencyKey: "payout:held", correlation_id: "op_held", status: "PENDING_APPROVAL" });
  await refusedBeforeSending(usdc("900000"), "insufficient_balance");
  assert.equal((await pay(usdc("500000"))).outcome, "settled", "what's left after the held payout may still be paid");
});

test("a payout repeating a held payout's recipient, asset and amount is refused before sending", async () => {
  const request = usdc("1");
  record({ at: new Date().toISOString(), idempotencyKey: "payout:held", kind: "payout", method: "transfer", request });
  record({ idempotencyKey: "payout:held", correlation_id: "op_held", status: "PENDING_APPROVAL" });
  await refusedBeforeSending(request, "duplicate_held_payout");
  // A different amount is a different payout.
  assert.equal((await pay(usdc("2"))).outcome, "settled");
});

test("only payees listed as confidential destinations of an only-mode policy are agreed", async () => {
  policy = except(["forbidden.near"]);
  assert.deepEqual([...await agreed()], []);
  policy = { ...payoutPolicy(["payee.near"]), destinations: { mode: "only", list: [
    { action: "transfer", address: "payee.near", confidential: true },
    { action: "transfer", address: "public.near", confidential: false },
  ] } };
  assert.deepEqual([...await agreed()], ["payee.near"]);
});

/** A provider approval holding a confidential USDC transfer of 1 to `to`. */
function heldPayment(to: string) {
  const terms = { to, token: ASSETS.USDC, amount: "1" };
  const request_hash = createHash("sha256")
    .update(canonical({ ...terms, chain: "near", flow: "transfer", kind: "confidential" })).digest("hex");
  mock.method(api, "getApproval", async () => ({ approval_id: "approval", wallet_id: fixtureWallet.wallet_id, status: "PENDING",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), request_hash, request_type: "confidential", request_data: terms }));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID, type: "transfer",
    status: "PENDING_APPROVAL", details: { approval_id: "approval" } }));
  return { approvalId: "approval", correlationId: "op_held", verdict: "approve" as const };
}

test("an approval releasing a payee an except-mode policy doesn't agree to is refused", async () => {
  policy = except(["forbidden.near"]);
  await assert.rejects(checkPaymentApproval(heldPayment("other.near")), /payee_not_agreed/);
});

test("a held withdrawal can be rejected but not approved: verifying its approval isn't built", async () => {
  policy = payoutPolicy(["payee.near"]);
  const vote = heldPayment("payee.near");
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID, type: "withdraw",
    status: "PENDING_APPROVAL", details: { approval_id: "approval" } }));
  await assert.rejects(checkPaymentApproval(vote), /approving a held withdrawal isn't available yet/);
  assert.equal((await checkPaymentApproval({ ...vote, verdict: "reject" })).binding.verdict, "reject");
});

test("a vote the approval check refuses reaches the caller as a refusal, not an unknown outcome: nothing was prepared", async () => {
  const approvalId = "93d2992b-84ca-4a28-b653-4cfe816c954a";
  const terms = { to: "payee.near", token: ASSETS.USDC, amount: "1" };
  mock.method(api, "getApproval", async () => ({ approval_id: approvalId, wallet_id: fixtureWallet.wallet_id, status: "PENDING",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), request_type: "confidential", request_data: terms,
    request_hash: createHash("sha256").update(canonical({ ...terms, chain: "near", flow: "withdraw", kind: "confidential" })).digest("hex") }));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID, type: "withdraw",
    status: "PENDING_APPROVAL", details: { approval_id: approvalId } }));
  const generate = mock.method(api, "generateIntent", async () => assert.fail("nothing is prepared for a refused vote"));
  const client = createRouterClient(router);
  await assert.rejects(client.owner.prepare({ action: { type: "approval_vote", approvalId, verdict: "approve", correlationId: "op_held" }, signer: "wallet" }),
    (error: unknown) => error instanceof ORPCError && error.code === "BAD_REQUEST" && (error.data as { kind?: string }).kind === "refused"
      && (error.data as { code?: string }).code === "local_authorization_held" && /approving a held withdrawal/.test(error.message));
  assert.equal(generate.mock.callCount(), 0);
});
