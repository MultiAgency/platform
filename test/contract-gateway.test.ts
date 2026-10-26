import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayDenialScope, gatewayDiscovery } from "../src/contract/gateway.js";

const discovery = { agents: [{ name: "payout", owner: "owner.near", dao: false, area: "payables", invoices: "https://pay.example/i/own-0123456789abcdef01234567/" }],
  invoices: "https://pay.example/", viewer: null };

test("discovery parsing never throws on untrusted entries: a non-URL or non-HTTP entry is a failed parse", () => {
  assert.equal(gatewayDiscovery.safeParse(discovery).success, true);
  for (const entry of ["not a url", "javascript:alert(1)", "ftp://pay.example/", ""]) {
    assert.equal(gatewayDiscovery.safeParse({ ...discovery, invoices: entry }).success, false, `host-wide ${entry}`);
    assert.equal(gatewayDiscovery.safeParse({ ...discovery, agents: [{ ...discovery.agents[0], invoices: entry }] }).success, false, `agent ${entry}`);
  }
});

test("a denial scope is read only when declared", () => {
  assert.equal(gatewayDenialScope({ error: "x", access: "procedure" }), "procedure");
  for (const body of [{ error: "x" }, { error: "x", access: "all" }, "<html>", null]) assert.equal(gatewayDenialScope(body), undefined);
});
