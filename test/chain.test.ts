import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { accountExists, daoPolicy, describeTreasury, nextProposalId } from "../src/chain.js";
import { treasuryGetOutput } from "../src/contract/owner-outputs.js";

/**
 * Whether an account is a DAO, or exists at all, is the chain's answer, never a failed read's. The bodies
 * are mainnet RPC answers to `call_function get_policy` and `view_account`, recorded 2026-10-13 (FastNear).
 */

afterEach(() => mock.restoreAll());

const rpc = (body: unknown) =>
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body as object }), {
    headers: { "content-type": "application/json" },
  }));
const viewError = (error: string) => ({ result: { block_hash: "5f8R8jZuPxPXMKk7ghU8ZtMJdAfqgRqfxHP2Ke7F3rC7", block_height: 219835073, error, logs: [] } });
const viewResult = (value: unknown) => ({ result: { block_hash: "5f8R8jZuPxPXMKk7ghU8ZtMJdAfqgRqfxHP2Ke7F3rC7", block_height: 219835073,
  result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [] } });

test("an account the chain says can't answer get_policy is not a DAO", async () => {
  // wrap.near: a contract without the method.
  rpc(viewError("wasm execution failed with error: MethodResolveError(MethodNotFound)"));
  assert.equal(await daoPolicy("wrap.near"), null);
  mock.restoreAll();
  // An account without a contract.
  rpc(viewError('wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "treasury.multiagentic.near" })'));
  assert.equal(await daoPolicy("treasury.multiagentic.near"), null);
  mock.restoreAll();
  // No such account.
  rpc({ error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", data: "account no-such-account-xyz-123.near does not exist while viewing",
    cause: { name: "UNKNOWN_ACCOUNT", info: { block_hash: "m52qmapGoB8zwjqWCWkTYRSYwdHKx8CwfdFgWfqECjg", block_height: 219835074, requested_account_id: "no-such-account-xyz-123.near" } } } });
  assert.equal(await nextProposalId("no-such-account-xyz-123.near"), null);
});

test("a DAO's views are read as answered", async () => {
  rpc(viewResult(54));
  assert.equal(await nextProposalId("agentic.sputnik-dao.near"), 54);
});

test("a failed read is no answer: it throws instead of saying the account isn't a DAO", async () => {
  // FastNear refuses a bad API key with 403, which near-kit doesn't retry. An unreachable RPC throws
  // the same way, after near-kit's retries (about 30 s).
  mock.method(globalThis, "fetch", async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }));
  await assert.rejects(daoPolicy("agentic.sputnik-dao.near"), { name: "NetworkError" });
  await assert.rejects(nextProposalId("agentic.sputnik-dao.near"), { name: "NetworkError" });
});

test("an account exists unless the chain says it doesn't; a failed read throws", async () => {
  rpc({ result: { amount: "306132631859932448916007858", block_hash: "MurZK6t14HL2Kc4kad6ZbLwHmaHU7CvmDFjJ2Pdsc8b", block_height: 219837126,
    code_hash: "11111111111111111111111111111111", locked: "0", storage_paid_at: 0, storage_usage: 1147 } });
  assert.equal(await accountExists("multiagentic.near"), true);
  mock.restoreAll();
  // An unfunded implicit account, such as a DAO's owner account before it is funded.
  const implicit = "ab".repeat(32);
  rpc({ error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", data: `account ${implicit} does not exist while viewing`,
    cause: { name: "UNKNOWN_ACCOUNT", info: { block_hash: "Hqdc11Rv1CMBjme6Jb3HH72K3pxpaNrLdb8UgS987MvV", block_height: 219836975, requested_account_id: implicit } } } });
  assert.equal(await accountExists(implicit), false);
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }));
  await assert.rejects(accountExists("multiagentic.near"), { name: "NetworkError" });
});

test("a treasury's balances are raw integer strings: yoctoNEAR and USDC at 6 decimals, as every amount on the wire", async () => {
  // multiagentic.near's view_account as recorded above (306.13 NEAR), a plain account (no get_policy), and 305.53 USDC.
  mock.method(globalThis, "fetch", async (_url: unknown, init: { body: string }) => {
    const { id, params } = JSON.parse(init.body);
    const body = params.request_type === "view_account"
      ? { result: { amount: "306132631859932448916007858", block_hash: "MurZK6t14HL2Kc4kad6ZbLwHmaHU7CvmDFjJ2Pdsc8b", block_height: 219837126,
        code_hash: "11111111111111111111111111111111", locked: "0", storage_paid_at: 0, storage_usage: 1147 } }
      : params.method_name === "ft_balance_of" ? viewResult("305530000")
      : viewError('wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "multiagentic.near" })');
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { headers: { "content-type": "application/json" } });
  });
  const treasury = await describeTreasury("multiagentic.near");
  assert.deepEqual(treasury.balances, { near: "306132631859932448916007858", usdc: "305530000" });
  const answer = { ...treasury, confidential: false, payees: [] };
  assert.equal(treasuryGetOutput.safeParse(answer).success, true);
  // A decimal, as near-kit's getBalance formats it, fails the contract.
  assert.equal(treasuryGetOutput.safeParse({ ...answer, balances: { near: "306.13", usdc: "305530000" } }).success, false);
});
