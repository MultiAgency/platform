import assert from "node:assert/strict";
import { test } from "node:test";
import { ORPCError } from "@orpc/server";
import { api } from "../src/api.js";
import { prepare } from "../src/owner-intents.js";
import { freshDirectory } from "./fixtures/harness.js";
import { walletIntent, walletSigner } from "./fixtures/wallet-signature.js";

freshDirectory("owner-action-open");

test("a second creation while one is open is refused owner_action_open, so an app can find the open one (#70)", async t => {
  const saved = { AGENT_ID: process.env.AGENT_ID, HOSTED_OWNER: process.env.HOSTED_OWNER, HOSTED_OWNER_KIND: process.env.HOSTED_OWNER_KIND,
    DASHBOARD_AREA: process.env.DASHBOARD_AREA };
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  delete process.env.AGENT_ID;
  Object.assign(process.env, { HOSTED_OWNER: walletSigner.account_id, HOSTED_OWNER_KIND: "wallet", DASHBOARD_AREA: "treasury" });
  t.mock.method(api, "generateIntent", async () => ({ type: "agent_create", correlation_id: "creation-1", preview: {},
    expires_at: new Date(Date.now() + 600_000).toISOString(), intent: walletIntent, signer: walletSigner }) as never);
  const first = await prepare({ type: "agent_create", owner: walletSigner });
  assert.equal(first.correlationId, "creation-1");
  await assert.rejects(prepare({ type: "agent_create", owner: walletSigner }), (error: unknown) =>
    error instanceof ORPCError && (error.data as { kind?: string; code?: string }).kind === "refused"
      && (error.data as { code?: string }).code === "owner_action_open");
});
