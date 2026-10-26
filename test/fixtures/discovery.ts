import assert from "node:assert/strict";
import { gatewayAgent, gatewayDiscovery } from "../../src/contract/gateway.js";

/** A real `/gw/me` answer parses against the published schema, and every field it carries is declared there. */
export function checkedDiscovery(body: unknown) {
  const parsed = gatewayDiscovery.safeParse(body);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  const undeclared = (value: object, shape: object) => Object.keys(value).filter(key => !(key in shape));
  assert.deepEqual(undeclared(parsed.data, gatewayDiscovery.shape), [], "undeclared discovery fields");
  for (const agent of parsed.data.agents) assert.deepEqual(undeclared(agent, gatewayAgent.shape), [], "undeclared agent fields");
  if (parsed.data.viewer) assert.deepEqual(undeclared(parsed.data.viewer, { account: 1, access: 1 }), [], "undeclared viewer fields");
  return parsed.data;
}
