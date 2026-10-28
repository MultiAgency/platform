import assert from "node:assert/strict";
import { test } from "node:test";
import { isIntervention, mayCall } from "../src/gateway/allowlist.js";
import { accessOf } from "../src/gateway/roles.js";
import { router } from "../src/router.js";

/**
 * Each DAO capability against every procedure the agent server really has, so a procedure added
 * later is checked too. Fixture roles only: no DAO membership changes.
 */

/** Every procedure's gateway path (`owner/prepare`), read from the router itself. */
function paths(node: object, prefix = ""): string[] {
  return Object.entries(node).flatMap(([name, child]) =>
    "~orpc" in child ? [`${prefix}${name}`] : paths(child as object, `${prefix}${name}/`));
}

/** What every admitted member may read. */
const READS = ["compensation/list", "instance", "setup", "overview", "policyHistory", "treasury/get", "activity", "unresolved", "held", "payouts/status", "autopilot/get", "autopilot/evidence",
  "autopilot/log", "strategy/get", "inbox/list", "ledger", "ledgerCsv", "reconcileBooks", "owner/status", "owner/pending", "owner/actions", "paymentHistory", "agreements/list", "paymentStatus", "invoices",
  "workOrders/list", "workOrders/get", "workOrders/status", "demoGuide/compose"];
/**
 * Preparations require FunctionCall proposal permission. None executes money or replaces the
 * owner's signature. The first three retain their historical non-intervention classification.
 */
const PROPOSES = ["owner/prepare", "agreements/propose", "agreements/offer", "rebalance", "externalPlan", "steward/propose", "deposit", "treasury/fund",
  "workOrders/create", "workOrders/prepare", "workOrders/deposit"];
const EXECUTES = ["compensation/prepare", "compensation/send", "compensation/review", "workOrders/file", "pay", "payouts/request", "sweep", "executePlan", "autopilot/tick", "autopilot/enable"];
const MANAGES = ["compensation/agreement", "strategy/save", "treasury/link", "treasury/unlink", "treasury/setConfidential", "agreements/decline"];
const MAINTAINS = ["autopilot/stop", "recover", "inbox/dismiss", "cancelPreparedInvoice"];

const policy = {
  proposal_bond: "0",
  roles: [
    { name: "Viewer", kind: { Group: ["viewer.near"] }, permissions: [], vote_policy: {} },
    { name: "Requestor", kind: { Group: ["requestor.near"] }, permissions: ["call:AddProposal", "call:VoteRemove"], vote_policy: {} },
    { name: "Approver", kind: { Group: ["approver.near"] }, permissions: ["call:VoteApprove"], vote_policy: {} },
    { name: "Executor", kind: { Group: ["executor.near"] }, permissions: ["call:*"], vote_policy: {} },
    { name: "Manager", kind: { Group: ["manager.near"] }, permissions: ["policy:*"], vote_policy: {} },
    { name: "Council", kind: { Group: ["council.near"] }, permissions: ["*:*"], vote_policy: {} },
  ],
  default_vote_policy: { threshold: [1, 2] },
};

const owner = { account: "fixture.sputnik-dao.near", policy, signer: "s" };
const access = (account: string) => accessOf(`${account}.near`, owner)!;

test("every procedure is explicitly assigned, with the internal ownership read denied to all browser callers", () => {
  const all = paths(router);
  assert.deepEqual(all.sort(), [...READS, ...PROPOSES, ...EXECUTES, ...MANAGES, ...MAINTAINS, "autopilot/set", "owner/submit", "workOrders/submit", "ownerIdentity"].sort());
  const wallet = accessOf("owner.near", { account: "owner.near", policy: null, signer: "owner.near" })!;
  for (const path of all) assert.equal(mayCall(wallet, path), path !== "ownerIdentity", path);
  for (const granted of [wallet, access("council")])
    for (const path of ["futureProcedure"])
      assert.equal(mayCall(granted, path), false, `${path} is not a browser procedure`);
});

test("DAO permission combinations reach exactly their allowed procedures", () => {
  const all = paths(router);
  for (const [account, allowed] of [
    ["viewer", READS],
    ["requestor", [...READS, ...PROPOSES]],
    ["approver", READS],
    ["executor", [...READS, ...PROPOSES, ...EXECUTES, ...MAINTAINS]],
    ["manager", [...READS, ...MANAGES, ...MAINTAINS]],
    ["council", [...READS, ...PROPOSES, ...EXECUTES, ...MANAGES, ...MAINTAINS, "autopilot/set"]],
  ] as const) {
    const granted = access(account);
    assert.equal(granted.canSign, false, account);
    assert.deepEqual(all.filter(path => mayCall(granted, path)).sort(), [...allowed].sort(), account);
  }
  assert.equal(accessOf("outsider.near", owner), null);
});

test("intervention classification remains compatible with existing unattended-run evidence", () => {
  const unrecorded = new Set([...READS.filter(path => path !== "invoices"), "owner/prepare", "agreements/propose", "agreements/offer",
    "workOrders/create", "workOrders/prepare"]);
  for (const path of paths(router)) assert.equal(isIntervention(path), !unrecorded.has(path), path);
});
