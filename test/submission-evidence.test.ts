import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createRouterClient } from "@orpc/server";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { pay } from "../src/agent.js";
import { api } from "../src/api.js";
import { mandateDigest } from "../src/mandate.js";
import { opsLog, readOps } from "../src/ops.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { router } from "../src/router.js";
import { unresolvedEvidence, unresolvedOutput } from "../src/contract/owner-outputs.js";
import { evidenceLog, readSubmissionEvidence } from "../src/submission-evidence.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

// Recovery design Part 1, option B: a claimed submission that fails without a proven outcome keeps the provider's
// answer beside the journal. It resolves nothing and changes no send, refusal or resolution.
const request = { asset: ASSETS.USDC, amount: "1", recipient: "fixture.near", confidential: true };
const policy = policyView(payoutPolicy(["fixture.near"]));
const expected = { revision: policy.revision, digest: mandateDigest(policy.policy) };
const providerError = (status: number, code: string, extra: { detail?: string; requestId?: string; meta?: Record<string, unknown> } = {}) =>
  new AgentApiError(status, { errors: [{ status: String(status), code, layer: "policy", title: code.replaceAll("_", " "), ...(extra.detail && { detail: extra.detail }),
    meta: { retryable: false, ...extra.meta } as never }], meta: { request_id: extra.requestId ?? "req_fixture" } });
let answer: () => Promise<{ correlation_id: string }>;
let sends = 0;

freshDirectory("submission-evidence");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  sends = 0;
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policy);
  const transfer = async () => { sends++; return answer(); };
  mock.method(api, "forGrant", () => ({ transfer, swap: transfer, shield: transfer, unshield: transfer }));
});
afterEach(() => mock.restoreAll());
const journal = () => readFileSync(opsLog(), "utf8").trim().split("\n");

test("an unrecognized provider refusal (policy_usage_unavailable) records its evidence and stays unresolved", async () => {
  answer = async () => { throw providerError(403, "policy_usage_unavailable", { requestId: "req_observed", meta: { correlation_id: "op_maybe" } }); };
  await assert.rejects(pay(request, expected), (error: unknown) => error instanceof AgentApiError);
  const op = readOps()[0]!;
  assert.equal(op.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(op.correlationId, undefined);
  assert.equal(op.refused, undefined, "evidence never resolves the operation");
  assert.equal(journal().length, 2, "the journal holds only the preparation and the claim: nothing new in it");
  const [evidence] = readSubmissionEvidence().get(op.idempotencyKey)!;
  assert.deepEqual({ ...evidence, at: undefined }, { idempotencyKey: op.idempotencyKey, at: undefined, httpStatus: 403, code: "policy_usage_unavailable",
    codes: ["policy_usage_unavailable"], retryable: false, requestId: "req_observed", providerIds: { correlation_id: "op_maybe" }, message: "policy usage unavailable" });
  // Still unresolved: the next send is refused and nothing more reaches the provider.
  await assert.rejects(pay(request, expected), /no proven outcome/);
  assert.equal(sends, 1);
});

test("a lost reply records no evidence and stays unresolved", async () => {
  answer = async () => { throw new TypeError("fetch failed: socket hang up"); };
  await assert.rejects(pay(request, expected));
  assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(existsSync(evidenceLog()) ? readFileSync(evidenceLog(), "utf8") : "", "", "no provider answer, so no evidence");
  await assert.rejects(pay(request, expected), /no proven outcome/);
  assert.equal(sends, 1);
});

test("a recognized refusal is resolved exactly as before and records no evidence", async () => {
  answer = async () => { throw providerError(403, "policy_denied"); };
  assert.deepEqual(await pay(request, expected), { outcome: "refused", code: "policy_denied" });
  assert.equal(readOps()[0]?.refused, "policy_denied");
  assert.equal(existsSync(evidenceLog()) ? readFileSync(evidenceLog(), "utf8") : "", "");
});

test("evidence keeps a short message without credentials or full bodies", async () => {
  const detail = `Grant ngt_0123456789abcdef rejected with key naa_secretvalue and Bearer abc.def; ${"x".repeat(400)}`;
  answer = async () => { throw providerError(503, "policy_usage_unavailable", { detail }); };
  await assert.rejects(pay(request, expected));
  const evidence = readSubmissionEvidence().get(readOps()[0]!.idempotencyKey)![0]!;
  assert.ok(evidence.message.length <= 200, `message length ${evidence.message.length}`);
  assert.doesNotMatch(JSON.stringify(evidence), /ngt_0123|naa_secret|Bearer abc/);
  assert.doesNotMatch(readFileSync(evidenceLog(), "utf8"), /x{250}/, "no full body on disk");
});

test("unresolved shows the latest evidence; operations without evidence show null", async () => {
  answer = async () => { throw providerError(403, "policy_usage_unavailable", { requestId: "req_shown" }); };
  await assert.rejects(pay(request, expected));
  const entry = (await createRouterClient(router).unresolved())[0]!;
  assert.equal(entry.sent, false);
  assert.deepEqual({ ...(entry.evidence as object), at: undefined },
    { at: undefined, httpStatus: 403, code: "policy_usage_unavailable", requestId: "req_shown", providerIds: {}, message: "policy usage unavailable",
      note: "Diagnostic only: this doesn't establish provider correlation or execution, or permission to clear the operation." });
  // Every field the server sends is declared in the published contract (a loose schema would otherwise pass it unchecked).
  const row = unresolvedOutput.element;
  assert.deepEqual(Object.keys(entry).filter(key => !(key in row.shape)), [], "undeclared unresolved fields");
  const declared = unresolvedEvidence.shape;
  assert.deepEqual(Object.keys(entry.evidence as object).filter(key => !(key in declared)), [], "undeclared evidence fields");
});

test("a malformed evidence line shows null evidence and never hides the unresolved operation", async () => {
  answer = async () => { throw providerError(403, "policy_usage_unavailable"); };
  await assert.rejects(pay(request, expected));
  const key = readOps()[0]!.idempotencyKey;
  // A later line that parses as JSON but isn't evidence (hand-edited or from an incompatible build) is the latest one.
  appendFileSync(evidenceLog(), JSON.stringify({ idempotencyKey: key, at: "2026-10-20T00:00:00Z", code: "x", httpStatus: "403", providerIds: [] }) + "\n");
  const [entry, ...rest] = await createRouterClient(router).unresolved();
  assert.equal(rest.length, 0);
  assert.equal(entry!.key, key);
  assert.equal(entry!.evidence, null);
});

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const CRASH = fileURLToPath(new URL("./fixtures/journal-crash.ts", import.meta.url));
const RECONCILE = fileURLToPath(new URL("../src/reconcile.ts", import.meta.url));
const child = (script: string, args: string[] = []) =>
  spawnSync(TSX, [script, ...args], { cwd: process.cwd(), env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 20_000 });

test("child process: an unproven refusal is recorded, reads back after restart and shows in reconcile's list", () => {
  process.env.AGENT_ID = "a".repeat(64);
  const run = child(CRASH, ["unproven_refusal"]);
  assert.equal(run.status, 0, run.stderr);
  rmSync(`${opsLog()}.lock`, { recursive: true, force: true });
  const op = readOps()[0]!;
  assert.equal(op.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(readSubmissionEvidence().get(op.idempotencyKey)?.[0]?.requestId, "req_fixture");
  const listed = child(RECONCILE);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`unresolved ${op.idempotencyKey} .*provider 403 policy_usage_unavailable, request req_fixture`));
  // The request id is diagnostic: the output says it establishes no correlation, execution or permission to clear.
  assert.match(listed.stdout, /Diagnostic only: this doesn't establish provider correlation or execution, or permission to clear the operation\./);
});

test("child process: a crash between the claim and the evidence write leaves a valid journal, still unresolved", () => {
  process.env.AGENT_ID = "a".repeat(64);
  const crashed = child(CRASH, ["before_evidence"]);
  assert.equal(crashed.status, 71, crashed.stderr);
  rmSync(`${opsLog()}.lock`, { recursive: true, force: true });
  assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED", "the journal reads and keeps the claim");
  assert.equal(readSubmissionEvidence().size, 0, "no evidence was written");
  const restarted = child(CRASH, ["recover"]);
  assert.notEqual(restarted.status, 0);
  assert.match(restarted.stderr, /no proven outcome/, "still blocks new sends");
  assert.equal(readFileSync("provider.jsonl", "utf8").trim().split("\n").length, 1, "exactly one send");
});
