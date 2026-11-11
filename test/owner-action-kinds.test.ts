import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ORPCError } from "@orpc/server";
import { api } from "../src/api.js";
import { prepare } from "../src/owner-intents.js";
import { freshDirectory } from "./fixtures/harness.js";
import { walletIntent, walletSigner } from "./fixtures/wallet-signature.js";

freshDirectory("owner-action-kinds");

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const dao = { owner: { account_id: "dao-owner.near" }, hash: "00", intent: {} };
/** Owner actions already on record, as the owner-intent store keeps them. */
const seed = (records: Record<string, object>) => {
  mkdirSync(".owner-intents", { recursive: true });
  writeFileSync(".owner-intents/.env.json", JSON.stringify(records));
};
const open = (error: unknown) => error instanceof ORPCError && (error.data as { code?: string }).code === "owner_action_open";
const generates = (t: { mock: { method: Function } }) => (t.mock.method as (o: object, m: string, f: Function) => void)(api, "generateIntent",
  async (request: { type: string }) => ({ type: request.type, correlation_id: `c-${request.type}-${Math.random()}`, preview: {}, expires_at: later(600_000),
    intent: walletIntent, signer: walletSigner }));

test("a submitted freeze holds a second freeze and an unfreeze; another kind of action isn't held", async t => {
  generates(t);
  seed({ held: { type: "agent_freeze", stage: "submitted", expiresAt: later(600_000), signedData: {} } });
  await assert.rejects(prepare({ type: "agent_freeze" }), open);
  await assert.rejects(prepare({ type: "agent_unfreeze" }), open, "a freeze and an unfreeze hold each other");
  assert.ok((await prepare({ type: "grant_revoke", grantId: "g" })).correlationId, "another kind proceeds");
});

test("a DAO's open, unexpired action holds its kind; a wallet's unsigned intent holds nothing", async t => {
  generates(t);
  seed({ vote: { type: "agent_unfreeze", stage: "prepared", expiresAt: later(600_000), dao } });
  await assert.rejects(prepare({ type: "agent_freeze" }), open, "a DAO's open vote holds the control");
  seed({ unsigned: { type: "agent_freeze", stage: "prepared", expiresAt: later(600_000) } });
  assert.ok((await prepare({ type: "agent_freeze" })).correlationId, "a wallet's unsigned intent holds nothing");
});

test("a settled action holds nothing", async t => {
  generates(t);
  seed({ done: { type: "agent_freeze", stage: "settled", expiresAt: later(-60_000), signedData: {}, result: { status: "SUCCESS" } } });
  assert.ok((await prepare({ type: "agent_unfreeze" })).correlationId);
});

test("an approval vote is held only by a vote on the same approval", async t => {
  generates(t);
  const binding = { approvalId: "approval-1", correlationId: "pay-1", verdict: "approve", requestHash: "h", recipient: "payee.near", asset: "a", amount: "1" };
  seed({ voted: { type: "approval_vote", stage: "submitted", expiresAt: later(600_000), signedData: {}, paymentApproval: binding } });
  await assert.rejects(prepare({ type: "approval_vote", approvalId: "approval-1", verdict: "approve", correlationId: "pay-1" }), open);
  // A vote on another held payout isn't held by this rule (it then needs that payout's own evidence, absent here).
  await assert.rejects(prepare({ type: "approval_vote", approvalId: "approval-2", verdict: "approve", correlationId: "pay-2" }), (error: unknown) => !open(error));
});
