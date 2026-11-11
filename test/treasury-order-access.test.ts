import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_CONSENT_TYPE, AppScope, appConsent, consentMessage, parseConsentMessage } from "../src/contract/app-consent.js";
import { APP_TREASURY_ORDERS, DAO_CONSENT_SCOPES, appScopesCover, daoScopesCover } from "../src/contract/app-access.js";
import { mayCall, type Access } from "../src/contract/permissions.js";

const paths = ["limitOrders/quote", "limitOrders/create", "limitOrders/get", "limitOrders/list", "limitOrders/approve",
  "limitOrders/reject", "limitOrders/place", "limitOrders/cancel", "limitOrders/refresh"] as const;
const orderScope = () => AppScope.parse("treasury-orders");
const base = (scopes: string[]) => ({ type: APP_CONSENT_TYPE, version: 1, host: "api.dev.multiagency.ai",
  deployment: "treasury-app", organization: "org_1", owner: "owner.near", agent: "portfolio",
  agentId: "a".repeat(64), scopes, expiresAt: "2027-01-01T00:00:00.000Z" });

test("Treasury order consent is explicit, depends on treasury, and binds the exact canonical scope", () => {
  assert.equal(appConsent.safeParse(base(["treasury-orders"])).success, false);
  assert.equal(appConsent.safeParse(base(["read", "treasury-orders"])).success, false);
  const parsed = appConsent.parse(base(["treasury-orders", "treasury"]));
  const { type: _type, version: _version, ...fields } = parsed;
  const signed = consentMessage(fields);
  assert.deepEqual(parseConsentMessage(signed)?.scopes, ["treasury", "treasury-orders"]);
  assert.equal(parseConsentMessage(signed.replace('"treasury","treasury-orders"', '"treasury-orders","treasury"')), null,
    "a reordered signed text is not the canonical consent");
  assert.ok((DAO_CONSENT_SCOPES as readonly string[]).includes(orderScope()), "a DAO can sign this same distinct consent scope");
});

test("only treasury with fresh treasury-orders consent reaches the nine order procedures", () => {
  assert.deepEqual(APP_TREASURY_ORDERS, paths);
  const dedicated = [AppScope.parse("treasury"), orderScope()];
  const old = [AppScope.parse("treasury"), AppScope.parse("treasury-execute")];
  for (const path of paths) {
    assert.equal(appScopesCover(["treasury"], path), false, path);
    assert.equal(appScopesCover(old, path), false, path);
    assert.equal(appScopesCover(["owner", "read", "payout", "market"], path), false, path);
    assert.equal(appScopesCover(dedicated, path), true, path);
    assert.equal(daoScopesCover(dedicated, path), true, path);
  }
  assert.equal(appScopesCover(dedicated, "limitOrders/unknown"), false);
});

test("owner access separates order reads, preparation, signature relay, and execution", () => {
  const none: Access = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
  const withAccess = (part: keyof Access): Access => ({ ...none, [part]: true });
  for (const path of ["limitOrders/quote", "limitOrders/get", "limitOrders/list", "limitOrders/refresh"])
    assert.equal(mayCall(none, path), true, path);
  assert.equal(mayCall(none, "limitOrders/create"), false);
  assert.equal(mayCall(withAccess("canPropose"), "limitOrders/create"), true);
  assert.equal(mayCall(withAccess("canSign"), "limitOrders/create"), true);
  for (const path of ["limitOrders/approve", "limitOrders/reject"]) {
    assert.equal(mayCall(withAccess("canPropose"), path), false, path);
    assert.equal(mayCall(withAccess("canExecute"), path), false, path);
    assert.equal(mayCall(withAccess("canSign"), path), true, path);
  }
  for (const path of ["limitOrders/place", "limitOrders/cancel"]) {
    assert.equal(mayCall(withAccess("canSign"), path), false, path);
    assert.equal(mayCall(withAccess("canPropose"), path), false, path);
    assert.equal(mayCall(withAccess("canExecute"), path), true, path);
  }
  assert.equal(mayCall({ ...none, canSign: true, canExecute: true }, "limitOrders/unlisted"), false);
});
