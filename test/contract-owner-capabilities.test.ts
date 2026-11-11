import assert from "node:assert/strict";
import { test } from "node:test";
import { router } from "../src/router.js";
import { mayCall } from "../src/gateway/allowlist.js";
import { ownerCapabilities, providedCapabilities } from "../src/contract/owner-capabilities.js";

const procedures = (node: object, prefix = ""): string[] => Object.entries(node).flatMap(([key, value]) =>
  value && typeof value === "object" ? "~orpc" in value ? [prefix + key] : procedures(value, `${prefix}${key}/`) : []);
const served = new Set(procedures(router));
const declared = new Set<string>(Object.values(ownerCapabilities).flatMap(c => c.procedures));
const full = { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true };

test("every capability names only procedures the router serves and the allowlist admits", () => {
  for (const [name, { procedures: listed }] of Object.entries(ownerCapabilities))
    for (const procedure of listed) {
      assert.ok(served.has(procedure), `${name}: ${procedure} is not served`);
      assert.ok(mayCall(full, procedure), `${name}: ${procedure} is not admitted for any account`);
    }
});

test("every admitted procedure belongs to some capability, so no release can use an undeclared route", () => {
  const uncovered = [...served].filter(p => mayCall(full, p) && !declared.has(p));
  assert.deepEqual(uncovered, []);
});

test("hosts provide the neutral set plus their areas' capabilities", () => {
  assert.deepEqual(providedCapabilities([]), ["gateway-session-v1", "agent-observe-v1", "agent-schedule-stop-v1", "agent-funding-v1", "owner-treasury-v1", "owner-intents-v1"]);
  const treasury = providedCapabilities(["treasury"]);
  assert.ok(treasury.includes("treasury-plans-v1") && !treasury.some(c => c.startsWith("payables-")));
  assert.ok(treasury.includes("treasury-limit-orders-v1"));
  assert.ok(providedCapabilities(["payables", "treasury"]).includes("payables-compensation-v1"));
});

test("capabilities never list an empty procedure set unless they name gateway routes", () => {
  for (const [name, { routes, procedures: listed }] of Object.entries(ownerCapabilities)) assert.ok(routes.length + listed.length > 0, name);
});

test("the schedule stop is provided wherever a schedule state can be read, on every host", () => {
  for (const areas of [[], ["payables"], ["treasury"]] as const) {
    const provided = providedCapabilities(areas);
    assert.ok(provided.includes("agent-observe-v1") && provided.includes("agent-schedule-stop-v1"), String(areas));
  }
  assert.ok((ownerCapabilities["agent-observe-v1"].procedures as readonly string[]).includes("autopilot/get"));
});
