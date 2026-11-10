import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";
import { ownerPrepareInput } from "../src/contract/inputs.js";
import { appMayAsk } from "../src/contract/app-access.js";
import { prepare } from "../src/owner-intents.js";
import { freshDirectory } from "./fixtures/harness.js";
import { walletIntent, walletSigner } from "./fixtures/wallet-signature.js";

freshDirectory("agent-archive");

for (const type of ["agent_archive", "agent_restore"] as const)
  test(`${type} is an owner action: an app may relay it, and the provider is asked for exactly that intent for this agent`, async t => {
    assert.ok(ownerPrepareInput.safeParse({ action: { type }, signer: "wallet" }).success, "the input accepts it");
    assert.ok(appMayAsk({ type }), "an app's owner consent covers relaying it");
    const requested: unknown[] = [];
    t.mock.method(api, "generateIntent", async (request: unknown) => {
      requested.push(request);
      return { type, correlation_id: `${type}-1`, expires_at: new Date(Date.now() + 290_000).toISOString(),
        preview: { summary: type }, intent: walletIntent, signer: walletSigner };
    });
    const prepared = await prepare({ type });
    assert.deepEqual(requested, [{ type, agent_id: process.env.AGENT_ID }]);
    assert.equal(prepared.correlationId, `${type}-1`);
  });

test("delete stays out: the platform prepares no agent_delete", () => {
  assert.equal(ownerPrepareInput.safeParse({ action: { type: "agent_delete" }, signer: "wallet" }).success, false);
});
