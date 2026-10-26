// Real process exits at durable journal boundaries; the provider is an offline stand-in.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { authorityFixture, policyView } from "./authority.js";
import { api } from "../../src/api.js";
import { dispatch } from "../../src/agent.js";
import { acquireMoneyLock } from "../../src/lock.js";
import { readOps } from "../../src/ops.js";
import { ASSETS, payoutPolicy } from "../../src/policy.js";

const mode = process.argv[2];
const log = `.ops/${process.env.AGENT_ID}.jsonl`;
process.env.AGENT_GRANT_TOKEN = "ngt_test";
const sync = fs.fsyncSync;
fs.fsyncSync = (fd: number) => {
  sync(fd);
  if (!fs.existsSync(log)) return;
  const last = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)!);
  if (mode === "after_prepare" && last.journalVersion === 2) process.exit(71);
  if (mode === "after_claim" && last.submissionState === "SUBMISSION_ATTEMPTED") process.exit(71);
};
// `before_evidence`: the provider refused without a proven outcome, and the process dies before its evidence is written.
const open = fs.openSync;
fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
  if (mode === "before_evidence" && String(args[0]).endsWith(".submission-evidence.ndjson")) process.exit(71);
  return open(...args);
}) as typeof fs.openSync;
syncBuiltinESMExports();
Object.assign(api, {
  ...authorityFixture(),
  getPolicy: async () => policyView(payoutPolicy(["alice.near"])),
  forGrant: () => ({ transfer: async () => {
    const operation = readOps().at(-1)!;
    if (operation.submissionState !== "SUBMISSION_ATTEMPTED") throw new Error("No durable claim before provider call");
    fs.appendFileSync("provider.jsonl", JSON.stringify({ key: operation.idempotencyKey }) + "\n");
    if (mode === "after_acceptance") process.exit(71);
    if (mode === "unproven_refusal" || mode === "before_evidence")
      throw new AgentApiError(403, { errors: [{ status: "403", code: "policy_usage_unavailable", layer: "policy", title: "Policy usage unavailable", meta: { retryable: false } }], meta: { request_id: "req_fixture" } });
    return { correlation_id: "op_test" };
  } }),
  getStatus: async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }),
});
const lock = await acquireMoneyLock();
try {
  if (mode !== "recover") await dispatch(lock, "payout", {
    method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "alice.near", confidential: true },
  }).catch(error => { if (mode !== "unproven_refusal") throw error; });
  console.log(JSON.stringify(readOps()));
} finally { await lock.release(); }
