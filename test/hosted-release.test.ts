import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, lstatSync } from "node:fs";
import { HostedAgents as PreviousHostedAgents } from "./fixtures/hosted-agents-055.js";
import { HostedAgents } from "../src/gateway/hosted-agents.js";
import { freshDirectory } from "./fixtures/harness.js";
freshDirectory("hosted-release");
const input = { owner: "alice.near", kind: "wallet" as const, area: "payables" as const };
const scope = { deployment: "fixture", organization: "first" };
test("release frees capacity, preserves settings, and restore keeps identity and refuses unfinished release", () => {
  const registry = new HostedAgents(".hosted", [], 1, 1);
  const agent = registry.reserve(input, scope);
  writeFileSync(agent.envFile, "AGENT_ID=retained\nAGENT_GRANT_TOKEN=retained-grant\nRELEASED_AT=2026-11-10T00:00:00.000Z\n");
  const record = registry.release(agent.name, { agentId: "retained", at: "2026-11-10T00:00:00.000Z", archiveCorrelationId: "archive" });
  assert.equal(record.state, "releasing");
  assert.deepEqual(new HostedAgents(".hosted", [], 1, 1).list(), []);
  assert.throws(() => registry.reserve(input, scope), /release.*finish/i);
  assert.match(readFileSync(agent.envFile, "utf8"), /retained-grant/);
  assert.equal(registry.release(agent.name, record).at, record.at);
  registry.completeRelease(agent.name);
  const second = registry.reserve(input, { ...scope, organization: "second" });
  assert.notEqual(second.name, agent.name);
  assert.throws(() => registry.reserve(input, scope), /capacity|limit/);
});
test("restore reuses the provider agent and key and never discards release history", () => {
  const registry = new HostedAgents(".hosted", []);
  const agent = registry.reserve(input, scope);
  writeFileSync(agent.envFile, "AGENT_ID=retained\nMARKET_PAYMENT_KEY=preserved\nRELEASED_AT=2026-11-10T00:00:00.000Z\n");
  registry.release(agent.name, { agentId: "retained", at: "2026-11-10T00:00:00.000Z", archiveCorrelationId: null });
  registry.completeRelease(agent.name);
  const restored = registry.reserve(input, scope);
  assert.equal(restored.name, agent.name);
  const env = readFileSync(agent.envFile, "utf8");
  assert.match(env, /AGENT_ID=retained/); assert.match(env, /MARKET_PAYMENT_KEY=preserved/);
  assert.doesNotMatch(env, /^RELEASED_AT=.+/m);
  assert.equal(registry.releases()[0]!.state, "restored");
  assert.match(env, /RESTORE_REQUIRED=retained/);
  writeFileSync(agent.envFile, env.replace("RESTORE_REQUIRED=retained", "RESTORE_REQUIRED="));
  registry.reserve(input, scope);
  assert.doesNotMatch(readFileSync(agent.envFile, "utf8"), /RESTORE_REQUIRED=retained/);
});
test("a crash after released.json but before removing apps.json stays released", () => {
  const registry = new HostedAgents(".hosted", []);
  const agent = registry.reserve(input, scope);
  const before = readFileSync(".hosted/apps.json", "utf8");
  registry.release(agent.name, { agentId: "retained", at: "2026-11-10T00:00:00.000Z", archiveCorrelationId: null });
  writeFileSync(".hosted/apps.json", before);
  const restarted = new HostedAgents(".hosted", []);
  assert.deepEqual(restarted.list(), []);
  restarted.release(agent.name, restarted.releases()[0]!);
  assert.equal(JSON.parse(readFileSync(".hosted/apps.json", "utf8")).entries.length, 0);
});

test("a completed release frees the 17th Organization slot in the default deployment limit", () => {
  const registry = new HostedAgents(".hosted", []);
  const agents = Array.from({ length: 16 }, (_, i) => registry.reserve(input, { ...scope, organization: `org_${i}` }));
  assert.throws(() => registry.reserve(input, { ...scope, organization: "org_16" }), /limit/);
  registry.release(agents[0]!.name, { agentId: "retained", at: "2026-11-10T00:00:00.000Z", archiveCorrelationId: null });
  registry.completeRelease(agents[0]!.name);
  assert.ok(registry.reserve(input, { ...scope, organization: "org_16" }));
  assert.equal(registry.list().length, 16);
});
test("restore cannot race an in-flight release lifecycle", async () => {
  const registry = new HostedAgents(".hosted", []);
  const agent = registry.reserve(input, scope);
  await registry.withLifecycle(agent.name, async () => {
    assert.throws(() => registry.reserve(input, scope), { code: "ELOCKED" });
  });
  assert.equal(registry.reserve(input, scope).name, agent.name);
});

for (const point of ["released.json", "apps.json"]) test(`a real process crash after ${point} preserves the retired identity and retry finishes`, () => {
  const registry = new HostedAgents(".hosted", []);
  const agent = registry.reserve(input, scope);
  writeFileSync(agent.envFile, "AGENT_ID=retained\nRELEASED_AT=2026-11-10T00:00:00.000Z\n");
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/hosted-release-crash.ts", import.meta.url)), agent.name, point], { cwd: process.cwd(), env: process.env });
  assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
  assert.deepEqual(new HostedAgents(".hosted", []).list(), []);
  // The child is proven dead: remove only this fixture's stale mutex before resuming recovery.
  rmSync(".hosted/registry.json.lock", { recursive: true });
  registry.release(agent.name, registry.releases()[0]!);
  registry.completeRelease(agent.name);
  assert.match(readFileSync(agent.envFile, "utf8"), /AGENT_ID=retained/);
  assert.deepEqual(registry.list(), []);
});

test("the 0.5.5 registry reader starts after a completed release, leaves it down, and refuses replacement over retained settings", () => {
  const registry = new HostedAgents(".hosted", []);
  const agent = registry.reserve(input, scope);
  writeFileSync(agent.envFile, "AGENT_ID=retained\nRELEASED_AT=2026-11-10T00:00:00.000Z\n");
  registry.release(agent.name, { agentId: "retained", at: "2026-11-10T00:00:00.000Z", archiveCorrelationId: null });
  registry.completeRelease(agent.name);
  const old = new PreviousHostedAgents(".hosted", []);
  assert.deepEqual(old.list(), []);
  assert.throws(() => old.reserve(input, scope), /unregistered settings/);
  assert.match(readFileSync(agent.envFile, "utf8"), /AGENT_ID=retained/);
});

test("restoration preserves a symlinked settings file and updates the same retained target", () => {
  const registry = new HostedAgents(".hosted", []);
  const agent = registry.reserve(input, scope);
  writeFileSync(agent.envFile, "AGENT_ID=retained\nAGENT_GRANT_TOKEN=retained\nRELEASED_AT=2026-11-10T00:00:00.000Z\n");
  registry.release(agent.name, { agentId: "retained", at: "2026-11-10T00:00:00.000Z", archiveCorrelationId: null });
  registry.completeRelease(agent.name);
  renameSync(agent.envFile, `${agent.envFile}.kept`);
  symlinkSync(`${agent.name}.env.kept`, agent.envFile);
  registry.reserve(input, scope);
  assert.equal(lstatSync(agent.envFile).isSymbolicLink(), true);
  assert.match(readFileSync(`${agent.envFile}.kept`, "utf8"), /RESTORE_REQUIRED=retained/);
  assert.doesNotMatch(readFileSync(`${agent.envFile}.kept`, "utf8"), /^RELEASED_AT=.+/m);
});
