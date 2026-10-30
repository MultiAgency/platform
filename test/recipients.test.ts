import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { recipientState } from "../src/recipients.js";

/** The real chain read (not the fixture's stand-in): final finality, and what each RPC answer means. */
test("a named recipient is read at final finality; an unknown account is absent, a failed read is unchecked", async t => {
  const asked: { finality?: string; request_type?: string; account_id?: string }[] = [];
  let answer: () => Response = () => Response.json({ jsonrpc: "2.0", id: 0, result: { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: "11111111111111111111111111111111" } });
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)).params);
    return answer();
  });
  assert.equal(await recipientState("payee.near"), "exists");
  assert.deepEqual(asked.at(-1), { request_type: "view_account", finality: "final", account_id: "payee.near" });
  answer = () => Response.json({ jsonrpc: "2.0", id: 0, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "ghost.near" } }, code: -32000, message: "Server error" } });
  assert.equal(await recipientState("ghost.near"), "absent");
  answer = () => { throw new TypeError("fetch failed"); };
  assert.equal(await recipientState("payee.near"), "unchecked");
  const before = asked.length;
  for (const implicit of ["a".repeat(64), "0x" + "b".repeat(40)]) assert.equal(await recipientState(implicit), "exists");
  assert.equal(asked.length, before, "implicit accounts are never read");
});

test("a withdrawal's registration is read on the token's contract at final finality: null is unregistered, an empty answer unchecked", async t => {
  const { ASSETS } = await import("../src/policy.js");
  const { registrationFor } = await import("../src/recipients.js");
  const asked: { request_type?: string; account_id?: string; method_name?: string; args_base64?: string; finality?: string }[] = [];
  const account = { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: "11111111111111111111111111111111" };
  let registration: number[] = [...Buffer.from(JSON.stringify({ total: "1250000000000000000000", available: "0" }))];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body));
    asked.push(params);
    return Response.json({ jsonrpc: "2.0", id: 0, result: params.request_type === "view_account" ? account : { result: registration, logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } });
  });
  const usdc = registrationFor(ASSETS.USDC)!;
  assert.equal(usdc, ASSETS.USDC.replace(/^nep141:/, ""));
  assert.equal(await recipientState("payee.near", usdc), "exists");
  assert.deepEqual(asked.at(-1), { request_type: "call_function", finality: "final", account_id: usdc, method_name: "storage_balance_of",
    args_base64: Buffer.from(JSON.stringify({ account_id: "payee.near" })).toString("base64") });
  registration = [...Buffer.from("null")];
  assert.equal(await recipientState("payee.near", usdc), "unregistered");
  assert.equal(await recipientState("a".repeat(64), usdc), "unregistered", "an implicit account is registered like any other");
  registration = [];
  assert.equal(await recipientState("payee.near", usdc), "unchecked", "no answer is never a registration");
  assert.equal(registrationFor(ASSETS.wNEAR), null, "wNEAR arrives as native NEAR");
  assert.equal(registrationFor("nep141:eth.omft.near"), null, "an asset a payout may not withdraw is authorize's refusal, not read");
});
