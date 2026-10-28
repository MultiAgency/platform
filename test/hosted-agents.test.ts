import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HostedAgents, authorizeSetup, hostedEnvironment } from "../src/gateway/hosted-agents.js";

test("new owners inherit only infrastructure, never existing-owner notifications, intake or credentials", () => {
  const env = hostedEnvironment({ name: "own-test", owner: "alice.near", kind: "wallet", area: "payables", port: 9000, envFile: ".hosted/own-test.env", executor: true }, {
    PATH: "/bin", NEAR_INTENTS_AGENT_API_KEY: "fixture-api", NEAR_RPC_URL: "http://127.0.0.1:9",
    AGENT_ID: "other-agent", AGENT_GRANT_TOKEN: "other-grant", AGENT_OWNER_PRIVATE_KEY: "private-key",
    TELEGRAM_BOT_TOKEN: "private-bot", TELEGRAM_CHAT_ID: "other-owner", NOTIFY_LINK: "other-owner",
    AGREEMENTS_URL: "other-intake", GRANT_PURPOSE: "invoices", INVOICES_PORT: "8790", SESSION_SECRET: "private-session",
    TREASURY_ACCOUNT: "other.near", AUTOPILOT: "on", EXECUTOR: "off", WORK_ORDER_ID: "other-order",
  });
  assert.deepEqual(env, { PATH: "/bin", NEAR_INTENTS_AGENT_API_KEY: "fixture-api", NEAR_RPC_URL: "http://127.0.0.1:9",
    ENV_FILE: ".hosted/own-test.env", PORT: "9000", DASHBOARD_AREA: "payables", HOSTED_OWNER: "alice.near", HOSTED_OWNER_KIND: "wallet", EXECUTOR: "on" });
});

test("interrupted reservation preserves orphan settings and refuses implicit repair", t => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-interrupted-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = { owner: "alice.near", kind: "wallet" as const, area: "treasury" as const };
  const first = new HostedAgents(dir, []).reserve(input);
  // Represents a crash after settings became durable but before the registry commit.
  unlinkSync(join(dir, "registry.json"));
  const before = readFileSync(first.envFile, "utf8");
  assert.throws(() => new HostedAgents(dir, []).reserve(input), /unregistered settings/);
  assert.equal(readFileSync(first.envFile, "utf8"), before);
});

test("self-service setup requires the wallet owner or a DAO member with proposal permission", () => {
  const wallet = { account: "alice.near", signer: "alice.near", policy: null };
  assert.doesNotThrow(() => authorizeSetup("alice.near", "wallet", wallet));
  assert.throws(() => authorizeSetup("bob.near", "wallet", wallet));
  assert.throws(() => authorizeSetup("alice.near", "dao", wallet));
  const dao = { account: "team.sputnik-dao.near", signer: "mpc.near", policy: {
    proposal_bond: "0", roles: [
      { name: "members", kind: { Group: ["alice.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
      { name: "everyone", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    ], default_vote_policy: { threshold: [1, 2] },
  } };
  assert.doesNotThrow(() => authorizeSetup("alice.near", "dao", dao));
  assert.throws(() => authorizeSetup("bob.near", "dao", dao));
  assert.throws(() => authorizeSetup("alice.near", "wallet", dao));
});

test("setup retries and restart retain one instance, settings and identity per owner and area", t => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new HostedAgents(dir, [], 2);
  const input = { owner: "alice.near", kind: "wallet" as const, area: "treasury" as const };
  const first = registry.reserve(input);
  writeFileSync(first.envFile, "AGENT_ID=retained\nAGENT_GRANT_TOKEN=private\n");
  assert.deepEqual(registry.reserve(input), first);
  const restarted = new HostedAgents(dir, [], 2);
  assert.deepEqual(restarted.reserve(input), first);
  assert.match(readFileSync(first.envFile, "utf8"), /AGENT_ID=retained/);
  const other = restarted.reserve({ ...input, area: "payables" });
  assert.notEqual(first.port, other.port);
  assert.notEqual(first.envFile, other.envFile);
  assert.throws(() => restarted.reserve({ ...input, owner: "bob.near" }), /capacity/);
  assert.deepEqual(restarted.reserve(input), first, "capacity never blocks existing setup recovery");
  assert.throws(() => restarted.reserve({ ...input, kind: "dao" }), /owner type/);
  writeFileSync(join(dir, "registry.json"), "{");
  assert.throws(() => new HostedAgents(dir, []), /registry/);
});

test("legacy configured agents and ports are preserved; an empty installation needs no conversion", t => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configured = [{ name: "old", owner: "alice.near", area: "treasury" as const, port: 9000, executor: true }];
  const registry = new HostedAgents(dir, configured);
  assert.throws(() => registry.reserve({ owner: "alice.near", kind: "wallet", area: "treasury" }), /existing agent/);
  const fresh = registry.reserve({ owner: "bob.near", kind: "wallet", area: "treasury" });
  assert.notEqual(fresh.port, 9000);
  assert.equal(readFileSync(fresh.envFile, "utf8"), "AUTOPILOT=off\n");
});

test("an app's setup gets its own agent per deployment, Organization, owner and area; existing entries keep their names", t => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-scoped-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A registry written before Organization scopes existed: its entry and name are kept as they are.
  const legacy = new HostedAgents(dir, []).reserve({ owner: "alice.near", kind: "wallet", area: "payables" });
  const before = readFileSync(join(dir, "registry.json"), "utf8");
  assert.equal(JSON.parse(before).entries[0].organization, undefined);
  assert.equal(legacy.name, `own-${createHash("sha256").update("alice.near:payables").digest("hex").slice(0, 24)}`, "unscoped names are unchanged");
  const configured = [{ name: "old", owner: "alice.near", area: "treasury" as const, port: 8999, executor: true }];
  const registry = new HostedAgents(dir, configured);
  const input = { owner: "alice.near", kind: "wallet" as const, area: "payables" as const };
  const org1 = registry.reserve(input, { deployment: "staging", organization: "org_1" });
  const org2 = registry.reserve(input, { deployment: "staging", organization: "org_2" });
  const production = registry.reserve(input, { deployment: "production", organization: "org_1" });
  const bob = registry.reserve({ ...input, owner: "bob.near" }, { deployment: "staging", organization: "org_1" });
  assert.equal(new Set([legacy.name, org1.name, org2.name, production.name, bob.name]).size, 5, "one agent per scope and owner");
  assert.equal(new Set([legacy.port, org1.port, org2.port, production.port, bob.port]).size, 5);
  assert.deepEqual([org1.deployment, org1.organization], ["staging", "org_1"]);
  assert.deepEqual(registry.reserve(input, { deployment: "staging", organization: "org_1" }), org1, "the same scope finds its agent again");
  assert.deepEqual(registry.reserve(input), legacy, "an unscoped setup still finds the owner's unscoped agent");
  assert.ok(registry.reserve({ ...input, area: "treasury" }, { deployment: "staging", organization: "org_1" }),
    "an operator-configured agent for the owner and area doesn't block an Organization's own agent");
  assert.throws(() => registry.reserve({ ...input, area: "treasury" }), /existing agent/, "but still blocks an unscoped setup");
  const restarted = new HostedAgents(dir, configured);
  assert.deepEqual(restarted.list().find(a => a.name === org2.name), org2, "scopes survive restart");
  assert.equal(restarted.list().find(a => a.name === legacy.name)?.organization, undefined);
  // What earlier releases read: unscoped entries only, in exactly their strict format, so a rollback still starts.
  const earlier = z.strictObject({ version: z.literal(1), entries: z.array(z.strictObject({ owner: z.string(), kind: z.enum(["wallet", "dao"]),
    area: z.enum(["treasury", "payables"]), name: z.string(), port: z.number() })) });
  assert.deepEqual(earlier.parse(JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"))).entries.map(e => e.name), [legacy.name],
    "Organization reservations stay out of the file earlier releases read");
  const file = JSON.parse(readFileSync(join(dir, "apps.json"), "utf8"));
  file.entries.find((e: { name: string }) => e.name === org1.name).organization = undefined;
  writeFileSync(join(dir, "apps.json"), JSON.stringify(file));
  assert.throws(() => new HostedAgents(dir, configured), /registry/, "half a scope no longer matches its name, so it is refused, never read as unscoped");
});

test("one app deployment can't take the host: its Organization agents are capped below the host's capacity", t => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-per-deployment-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new HostedAgents(dir, [], 6, 3);
  const input = { owner: "alice.near", kind: "wallet" as const, area: "payables" as const };
  for (const organization of ["o1", "o2", "o3"]) registry.reserve(input, { deployment: "staging", organization });
  assert.throws(() => registry.reserve(input, { deployment: "staging", organization: "o4" }), /hosted agent limit/);
  assert.ok(registry.reserve(input, { deployment: "production", organization: "o4" }), "another deployment still can");
  assert.ok(registry.reserve(input), "and so can self-service");
  assert.ok(registry.reserve(input, { deployment: "staging", organization: "o1" }), "an existing reservation is always found again");
});
