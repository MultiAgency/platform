import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { mayCall } from "../src/gateway/allowlist.js";
import { childEnv, hostOf, loadConfig } from "../src/gateway/config.js";
import { BadRequest } from "../src/http.js";
import { CHALLENGE_TTL_MS, issueChallenge, type KeyLookup, parseSignIn, SESSION_TTL_MS, sessionAccount, sessions, sessionToken, verifySignIn } from "../src/signin.js";
import { accessOf } from "../src/gateway/roles.js";
import { council } from "../src/chain.js";

const HOST = "dao.test";

/** Signs a challenge the way a wallet does (near-kit's NEP-413 signer), for `account`. */
async function signIn(account = "alice.near", host = HOST, callbackUrl?: string) {
  const key = generateKey();
  const challenge = issueChallenge(HOST);
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: account });
  const signed = await near.signMessage({ message: challenge.message, recipient: host, nonce: Buffer.from(challenge.nonce, "base64"), callbackUrl });
  return { accountId: account, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, callbackUrl };
}
const fullAccess: KeyLookup = async () => "FullAccess";

test("a wallet's signature over a fresh challenge signs the account in", async () => {
  assert.equal(await verifySignIn(await signIn(), HOST, fullAccess), "alice.near");
});

test("a wallet that signs a callback URL on this site signs in; one elsewhere is refused", async () => {
  assert.equal(await verifySignIn(await signIn("alice.near", HOST, `https://${HOST}/`), HOST, fullAccess), "alice.near");
  await assert.rejects(verifySignIn(await signIn("alice.near", HOST, "https://evil.test/"), HOST, fullAccess), /callback URL is not this site/);
  // A wallet that fills in the callback itself: the page offers what it might be, and one matches.
  const unreported = await signIn("alice.near", HOST, `https://${HOST}/a/treasury/`);
  assert.equal(
    await verifySignIn({ ...unreported, callbackUrl: undefined, callbackUrls: [`https://${HOST}/`, `https://${HOST}/a/treasury/`] }, HOST, fullAccess),
    "alice.near",
  );
  // The callback is part of what was signed: dropping or changing it breaks the signature.
  const signed = await signIn("alice.near", HOST, `https://${HOST}/`);
  await assert.rejects(verifySignIn({ ...signed, callbackUrl: null }, HOST, fullAccess), /doesn't match/);
});

test("a wallet that signs the page's URL as NEP-413 callbackUrl verifies with it (real sign-in, 2026-10-12)", async () => {
  const { nep413Hash, signatureBytes, verifyEd25519 } = await import("../src/nep413.js");
  const key = "ed25519:7g2kKQYuRXPVhn8HTLiRdBfJTF1fd7UZ8xASAcrht3nk";
  const signature = signatureBytes("uu24iawRTfSXfM4A5gFcO4XRt0l9ZaVJw8UI7ARMFSV0kuTDxAarmhliRjJBDD7UwD3+sKroBOX75NmeuihNDw==");
  const nonce = Buffer.from("m8M+4IBj1wrjbIOG8NW7WNWNzJcfOzWL4dMw0FUN06s=", "base64");
  const message = "Sign in to localhost:8791";
  assert.equal(verifyEd25519(key, nep413Hash(message, nonce, "localhost:8791"), signature), false);
  assert.equal(verifyEd25519(key, nep413Hash(message, nonce, "localhost:8791", "http://localhost:8791/"), signature), true);
});

test("a sign-in body is read strictly: four strings, and at most three offered callback URLs", () => {
  const body = { accountId: "alice.near", publicKey: "ed25519:k", signature: "s", nonce: "n" };
  assert.deepEqual(parseSignIn({ ...body, callbackUrls: ["a", 1, "b", "c", "d"], extra: true }), { ...body, callbackUrls: ["a", "b", "c"] });
  assert.throws(() => parseSignIn({ ...body, nonce: 1 }), BadRequest);
});

test("a challenge signs in once", async () => {
  const attempt = await signIn();
  await verifySignIn(attempt, HOST, fullAccess);
  await assert.rejects(verifySignIn(attempt, HOST, fullAccess), /Unknown or used/);
});

test("an expired challenge is refused", async () => {
  await assert.rejects(verifySignIn(await signIn(), HOST, fullAccess, Date.now() + CHALLENGE_TTL_MS + 1), /expired/);
});

test("a signature for another site is refused", async () => {
  await assert.rejects(verifySignIn(await signIn("alice.near", "evil.test"), HOST, fullAccess), /doesn't match/);
});

test("a signature can't be moved to another account or key", async () => {
  const attempt = await signIn();
  const other = await signIn();
  await assert.rejects(verifySignIn({ ...attempt, publicKey: other.publicKey }, HOST, fullAccess), /doesn't match/);
});

test("the key must be a full-access key of the claimed account", async () => {
  await assert.rejects(verifySignIn(await signIn("bob.near"), HOST, async () => null), /is not a key of bob\.near/);
  await assert.rejects(verifySignIn(await signIn(), HOST, async () => "FunctionCall"), /full-access/);
});

test("a session names its account until it expires, and can't be forged or altered", () => {
  const token = sessionToken("alice.near", "secret");
  assert.equal(sessionAccount(token, "secret"), "alice.near");
  assert.equal(sessionAccount(token, "other secret"), null);
  const [, expires, mac] = token.split(".");
  assert.equal(sessionAccount(`${Buffer.from("bob.near").toString("base64url")}.${expires}.${mac}`, "secret"), null);
  assert.equal(sessionAccount(token, "secret", Date.now() + SESSION_TTL_MS + 1), null);
  assert.equal(sessionAccount(undefined, "secret"), null);
});

test("an app's session cookie is read back only under its own name", () => {
  const dao = sessions({ cookie: "dao_session", secret: "secret", secure: true });
  const opened = dao.open("alice.near");
  assert.match(opened, /^dao_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const request = (cookie: string) => ({ headers: { cookie } }) as never;
  const pair = opened.split(";")[0]!;
  assert.equal(dao.account(request(`theme=dark; ${pair}`)), "alice.near");
  assert.equal(sessions({ cookie: "invoices_session", secret: "secret", secure: false }).account(request(pair)), null);
  assert.equal(dao.account({ headers: {} } as never), null);
  assert.equal(dao.close(), "dao_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
  assert.doesNotMatch(sessions({ cookie: "c", secret: "s", secure: false }).close(), /Secure/);
});

const policy = {
  proposal_bond: "0",
  roles: [
    { name: "council", kind: { Group: ["alice.near", "carol.near"] }, permissions: ["*:AddProposal", "*:VoteApprove"], vote_policy: {} },
    { name: "requestors", kind: { Group: ["dave.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
    { name: "all", kind: "Everyone", permissions: ["*:Finalize"], vote_policy: {} },
  ],
  default_vote_policy: { threshold: [1, 2] },
};

const walletAccess = { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true };
const readerAccess = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };

test("an agent owned by a plain account is accessible only to that owner", () => {
  const owner = { account: "james.near", policy: null, signer: "james.near" };
  assert.deepEqual(accessOf("james.near", owner), walletAccess);
  assert.equal(accessOf("ops.near", owner), null);
  assert.equal(accessOf("alice.near", owner), null);
});

test("DAO members' capabilities come from their on-chain permissions, without wallet signing authority", () => {
  const owner = { account: "x.sputnik-dao.near", policy, signer: "s" };
  assert.deepEqual(accessOf("alice.near", owner), { ...readerAccess, canPropose: true, canVote: true, canExecute: true, canManage: true });
  assert.deepEqual(accessOf("dave.near", owner), { ...readerAccess, canPropose: true });
  assert.equal(accessOf("mallory.near", owner), null);
});

test("an account outside the DAO's groups has no private agent access", () => {
  const owner = { account: "x.sputnik-dao.near", policy, signer: "s" };
  assert.equal(accessOf("ops.near", owner), null);
});

test("Everyone proposal permissions apply to admitted group members without admitting outsiders", () => {
  const dao = { ...policy, roles: [
    { name: "viewers", kind: { Group: ["viewer.near"] }, permissions: [], vote_policy: {} },
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
  ] };
  const owner = { account: "x.sputnik-dao.near", policy: dao, signer: "s" };
  assert.deepEqual(accessOf("viewer.near", owner), { ...readerAccess, canPropose: true });
  assert.equal(accessOf("outsider.near", owner), null);
});

test("direct app execution and management require both relevant proposal and approval permissions", () => {
  for (const [permissions, execute, manage] of [
    [["call:AddProposal"], false, false],
    [["call:VoteApprove"], false, false],
    [["call:AddProposal", "call:VoteApprove"], true, false],
    [["policy:AddProposal"], false, false],
    [["policy:VoteApprove"], false, false],
    [["policy:AddProposal", "policy:VoteApprove"], false, true],
    [["call:*"], true, false],
    [["policy:*"], false, true],
    [["*:*"], true, true],
  ] as const) {
    const dao = { ...policy, roles: [{ name: "members", kind: { Group: ["m.near"] }, permissions: [...permissions], vote_policy: {} }] };
    const access = accessOf("m.near", { account: "x.sputnik-dao.near", policy: dao, signer: "s" })!;
    assert.equal(access.canExecute, execute, permissions.join(","));
    assert.equal(access.canManage, manage, permissions.join(","));
    assert.equal(access.canSign, false, "DAO members never gain the owner's wallet signature");
  }
});

/**
 * Every permission form Sputnik grants a FunctionCall vote with (`<kind>:<action>`, `<kind>:*`, `*:<action>`, `*:*`;
 * sputnik-dao-contract 5434a59, sputnikdao2/src/policy.rs `can_execute_action`): the gateway's vote and the
 * treasury page's approvers agree on each, and a vote on another kind grants neither.
 */
test("a FunctionCall vote is read the way the DAO contract grants it, in the gateway and the approvers alike", () => {
  for (const [permission, votes] of [["call:VoteApprove", true], ["call:*", true], ["*:VoteApprove", true], ["*:*", true],
    ["transfer:VoteApprove", false], ["call:VoteReject", false]] as const) {
    const dao = { ...policy, roles: [{ name: "voters", kind: { Group: ["v.near"] }, permissions: [permission], vote_policy: {} }] };
    assert.equal(accessOf("v.near", { account: "x.sputnik-dao.near", policy: dao, signer: "s" })?.canVote, votes, permission);
    assert.deepEqual(council(dao).approvers.map((a) => a.role), votes ? ["voters"] : [], permission);
  }
});

test("a token-weighted role names no accounts: sign-in and the council read past it", () => {
  const dao = { ...policy, roles: [{ name: "holders", kind: { Member: "1" }, permissions: ["*:*"], vote_policy: {} }, ...policy.roles] };
  assert.deepEqual(accessOf("alice.near", { account: "x.sputnik-dao.near", policy: dao, signer: "s" }), { ...readerAccess, canPropose: true, canVote: true, canExecute: true, canManage: true });
  assert.equal(accessOf("mallory.near", { account: "x.sputnik-dao.near", policy: dao, signer: "s" }), null);
  assert.deepEqual(council(dao).members, ["alice.near", "carol.near", "dave.near"]);
});

test("private reads need membership; preparing and submitting owner actions need their own capabilities", () => {
  for (const path of ["overview", "activity", "held", "ledgerCsv", "owner/pending", "invoices"]) assert.ok(mayCall(readerAccess, path), path);
  for (const path of ["owner/prepare", "agreements/offer", "pay", "sweep", "executePlan", "autopilot/set", "autopilot/tick", "recover", "treasury/link", "owner/submit"])
    assert.ok(!mayCall(readerAccess, path), path);
  assert.ok(mayCall({ ...readerAccess, canPropose: true }, "owner/prepare"));
  assert.ok(!mayCall({ ...readerAccess, canPropose: true, canVote: true, canExecute: true, canManage: true }, "owner/submit"));
  assert.ok(mayCall(walletAccess, "owner/submit"));
  for (const path of ["someFutureProcedure", "ownerIdentity"]) assert.equal(mayCall(walletAccess, path), false, path);
});

test("an approve-only agent server starts with EXECUTOR=off; gateway secrets never reach agent servers", () => {
  const parent = { SESSION_SECRET: "s".repeat(40), DASHBOARD_HOST: "x.test", DASHBOARD_FILE: "d.json", EXECUTOR: "off", NEAR_INTENTS_AGENT_API_KEY: "naa_k" };
  const executor = childEnv({ name: "treasury", owner: "dao.near", envFile: ".env.dao", port: 8789, executor: true }, parent);
  assert.deepEqual(
    { ...executor },
    { NEAR_INTENTS_AGENT_API_KEY: "naa_k", ENV_FILE: ".env.dao", PORT: "8789" },
    "the executor: shared keys, its own file and port, no EXECUTOR=off inherited",
  );
  const approver = childEnv({ name: "payout", owner: "dao.near", envFile: ".env.payout", port: 8790, executor: false }, parent);
  assert.equal(approver.EXECUTOR, "off");
  assert.equal(approver.SESSION_SECRET, undefined);
});

test("the deployed configuration: both agents owned by the DAO, the treasury agent executed here, the payout agent approve-only", () => {
  const config = loadConfig("deploy/dashboard.json");
  assert.equal(config.host, "proto.multiagency.ai");
  assert.deepEqual(
    config.agents.map((a) => [a.name, a.owner, a.envFile, a.executor]),
    [
      ["treasury", "agentic.sputnik-dao.near", ".env.dao", true],
      ["payout", "agentic.sputnik-dao.near", ".env.payout", false],
    ],
  );
});

test("legacy operators in dashboard configuration are ignored and cannot grant access", () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-dashboard-"));
  try {
    const file = join(dir, "dashboard.json");
    writeFileSync(file, JSON.stringify({ host: HOST, agents: [{ name: "treasury", owner: "x.sputnik-dao.near", operators: ["ops.near"], port: 8789 }] }));
    const [agent] = loadConfig(file).agents;
    assert.equal("operators" in agent!, false);
    assert.equal(accessOf("ops.near", { account: agent!.owner, policy, signer: "s" }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a sign-in host may be given bare or as a URL", () => {
  for (const value of ["dao.example.com", "https://dao.example.com", "https://dao.example.com/", "dao.example.com/"]) assert.equal(hostOf(value), "dao.example.com");
  assert.equal(hostOf("http://localhost:8800"), "localhost:8800");
});
