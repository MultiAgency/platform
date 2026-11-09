import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createGrantCredential } from "@near-intents-agent-api/sdk";
import { DEFAULT_GRANT_MS, MAX_GRANT_MS, MIN_GRANT_MS, ownerPrepareInput } from "../src/contract/inputs.js";
import { adoptStagedGrant, grantLabel, grantRequest, promoteGrantToken, stageGrantToken } from "../src/grants.js";
import { api } from "../src/api.js";
import { prepare } from "../src/owner-intents.js";
import { freshDirectory } from "./fixtures/harness.js";
import { walletIntent, walletSigner } from "./fixtures/wallet-signature.js";

// Every test gets an empty directory: the settings file is written to the working directory.
freshDirectory("grants");

const [old, next] = [createGrantCredential(), createGrantCredential()];
type Grants = Parameters<typeof adoptStagedGrant>[0];
const grant = (credential: string, { days = 1, revoked = false } = {}) =>
  ({
    revoked_at: revoked ? new Date().toISOString() : null,
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    owner_message: { credential },
  }) as unknown as Grants[number];

/** The token in use and the staged one, as this process sees them. */
const tokens = () => [process.env.AGENT_GRANT_TOKEN || null, process.env.AGENT_GRANT_TOKEN_PENDING || null];
const staged = () => Object.assign(process.env, { AGENT_GRANT_TOKEN: old.token, AGENT_GRANT_TOKEN_PENDING: next.token });

test("a staged token waits beside the token in use until its grant is in force", () => {
  Object.assign(process.env, { AGENT_GRANT_TOKEN: old.token, AGENT_GRANT_TOKEN_PENDING: "" });
  stageGrantToken(next.token);
  assert.deepEqual(tokens(), [old.token, next.token]);
  promoteGrantToken(next.token);
  assert.deepEqual(tokens(), [next.token, null]);
  assert.equal(readFileSync(".env", "utf8"), `AGENT_GRANT_TOKEN=${next.token}\nAGENT_GRANT_TOKEN_PENDING=\n`);
});

test("a staged token whose grant is not in force is never adopted", () => {
  const cases: [string, Grants][] = [
    ["not issued", [grant(old.commitment)]],
    ["revoked", [grant(old.commitment), grant(next.commitment, { revoked: true })]],
    ["expired", [grant(old.commitment), grant(next.commitment, { days: -1 })]],
  ];
  for (const [name, grants] of cases) {
    staged();
    adoptStagedGrant(grants);
    assert.deepEqual(tokens(), [old.token, next.token], name);
  }
});

test("a staged token whose grant is in force is adopted, even while the token in use still works", () => {
  staged();
  adoptStagedGrant([grant(old.commitment), grant(next.commitment)]);
  assert.deepEqual(tokens(), [next.token, null]);
});

test("a grant's label names its purpose, then any suffix the owner's signature binds", () => {
  assert.equal(grantLabel("payout"), "payout");
  assert.equal(grantLabel("invoices"), "invoices");
  const digest = "0123456789abcdef0123456789abcdef";
  assert.equal(grantLabel("treasury", digest), `treasury:${digest}`);
});

test("a label over the API's 64 characters is refused before anything is signed", () => {
  assert.equal(grantLabel("treasury", "x".repeat(55)).length, 64);
  assert.throws(() => grantLabel("treasury", "x".repeat(56)), /64 characters/);
});

test("an owner may name a grant's expiry up to the provider's 365 days; unnamed, it lasts 30 days", async () => {
  const now = Date.now();
  const ends = new Date(now + 10 * 86_400_000).toISOString();
  assert.equal((await grantRequest({ label: "payout", expiresAt: ends })).request.expires_at, ends);
  // A contract's length: longer than the default, within the provider's maximum (Agent API skills: at most 365 days).
  const contractEnd = new Date(now + 200 * 86_400_000).toISOString();
  assert.equal((await grantRequest({ label: "payout", expiresAt: contractEnd })).request.expires_at, contractEnd);
  assert.equal(MAX_GRANT_MS, 365 * 86_400_000);
  // Unnamed, the grant lasts 30 days, as before.
  const fallback = Date.parse((await grantRequest({ label: "payout" })).request.expires_at);
  assert.equal(DEFAULT_GRANT_MS, 30 * 86_400_000);
  assert.ok(Math.abs(fallback - (now + DEFAULT_GRANT_MS)) < 60_000);
  // Refused, never clamped: the owner signs the expiry they asked for or nothing.
  for (const [name, at] of [["past", now - 1_000], ["under the minimum", now + MIN_GRANT_MS - 60_000], ["beyond the maximum", now + MAX_GRANT_MS + 60_000]] as const)
    await assert.rejects(grantRequest({ label: "payout", expiresAt: new Date(at).toISOString() }), /grant/i, name);
  await assert.rejects(grantRequest({ label: "payout", expiresAt: "soon" }), /grant/i);
});

test("the owner's review of a prepared grant shows the expiry the provider was asked to sign", async t => {
  const requested: { expires_at?: string; label?: string }[] = [];
  t.mock.method(api, "generateIntent", async (request: { expires_at: string; label: string }) => {
    requested.push(request);
    return { type: "grant_issue", correlation_id: `grant-${requested.length}`, expires_at: new Date(Date.now() + 290_000).toISOString(),
      preview: { summary: "Issue a grant" }, intent: walletIntent, signer: walletSigner };
  });
  const ends = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const prepared = await prepare({ type: "grant_issue", label: "payout", expiresAt: ends });
  assert.equal(requested[0]?.expires_at, ends);
  assert.deepEqual(prepared.grant, { label: "payout", expiresAt: ends });
  await assert.rejects(prepare({ type: "grant_issue", label: "payout", expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() }), /grant/i);
  assert.equal(requested.length, 1, "a refused expiry asks the provider for nothing");
});

test("grant_issue's optional expiresAt is an ISO timestamp, and an old client's request without it still parses", () => {
  const at = "2026-12-01T00:00:00.000Z";
  assert.deepEqual(ownerPrepareInput.parse({ signer: "dao", action: { type: "grant_issue", label: "treasury", expiresAt: at } }).action,
    { type: "grant_issue", label: "treasury", expiresAt: at });
  assert.deepEqual(ownerPrepareInput.parse({ signer: "wallet", action: { type: "grant_issue", label: "payout" } }).action, { type: "grant_issue", label: "payout" });
  assert.equal(ownerPrepareInput.safeParse({ signer: "wallet", action: { type: "grant_issue", expiresAt: "next month" } }).success, false);
});
