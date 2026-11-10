import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HostedAgents } from "../src/gateway/hosted-agents.js";
import { HostedAgents as PreviousHostedAgents } from "./fixtures/hosted-agents-055.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("market-rollback");

test("a mixed market host cannot downgrade to 0.5.5; refusal preserves every reservation and key before any hire", () => {
  const registry = new HostedAgents(".hosted", []);
  registry.reserve({owner: "alice.near", kind: "wallet", area: "treasury"});
  registry.reserve({owner: "alice.near", kind: "wallet", area: "payables"}, {deployment: "fixture", organization: "payables"});
  assert.equal(new PreviousHostedAgents(".hosted", []).list().length, 2);
  const market = registry.reserve({owner: "alice.near", kind: "wallet", area: "market"}, {deployment: "fixture", organization: "market"});
  const snapshot = () => Object.fromEntries(readdirSync(".hosted").sort().map(name => [name, readFileSync(join(".hosted", name), "utf8")]));
  const before = snapshot();
  assert.match(readFileSync(market.envFile, "utf8"), /MARKET_PAYMENT_KEY=ed25519:/);
  assert.equal(existsSync(".ops"), false, "the rollback boundary is reservation, before any payment journal");
  assert.throws(() => new PreviousHostedAgents(".hosted", []), /Hosted agent registry is unavailable/);
  assert.deepEqual(snapshot(), before, "the old reader must not rewrite the retained state");
  assert.equal(new HostedAgents(".hosted", []).list().length, 3, "resume the compatible version with all agents preserved");
});
