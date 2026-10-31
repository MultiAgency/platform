import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { receipts } from "../evidence/receipts.js";
import { copyPath, receiptProblems, sanitize } from "../scripts/evidence-receipts.js";

// The evidence view's "Recorded simulation" entries: sanitized copies pinned to their source receipts.
test("every receipt copy is pinned, carries no local path, and matches its sanitized source where present", () => {
  assert.ok(receipts.length > 0);
  assert.deepEqual(receiptProblems(), []);
});

test("an edited copy fails the check", () => {
  const path = copyPath(receipts[0]!.id), original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, original.replace(/"completed": true/, '"completed": false').replace(/\n$/, " \n"));
    assert.ok(receiptProblems().some(problem => problem.startsWith(`${receipts[0]!.id}: copy changed`)));
  } finally { writeFileSync(path, original); }
  assert.deepEqual(receiptProblems(), []);
});

test("sanitizing keeps identities and outcomes and drops local paths and the stack", () => {
  const raw = { scenario: "/Users/example/scenarios/sponsorship.json", stack: { dashboard: "https://127.0.0.1:1" },
    inputs: { payee: "payee.near", amountUsdc: "20" }, steps: [{ step: "Paid", status: "SUCCESS", invoiceId: "e215" }], proto: { path: "/private/tmp/x/snapshot", snapshot: { runDigest: "9d13" } } };
  assert.deepEqual(sanitize(raw), { scenario: "<local>/sponsorship.json", inputs: { payee: "payee.near", amountUsdc: "20" },
    steps: [{ step: "Paid", status: "SUCCESS", invoiceId: "e215" }], proto: { path: "<local>/snapshot", snapshot: { runDigest: "9d13" } } });
});
