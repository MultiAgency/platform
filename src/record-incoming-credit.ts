import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { api } from "./api.js";
import { agentId } from "./env.js";
import lockfile from "proper-lockfile";
import { STALE_MS, UnresolvedOperations } from "./lock.js";
import { opsLog, readOps, blocksDispatch } from "./ops.js";
import { incomingCredit, recordIncomingCredit, type IncomingCredit } from "./incoming-credits.js";

/** A successful provider transfer must bind exact credit terms; a signature or proposal alone is not settlement. */
export function assertProviderCredit(credit: IncomingCredit, status: { correlation_id: string; type: string; status: string; updated_at?: string; details?: unknown }) {
  const d = status.details as Record<string, unknown> | undefined;
  const request = d?.request as Record<string, unknown> | undefined;
  const evidence = d?.evidence as Record<string, unknown> | undefined;
  const field = (key: string) => d?.[key] ?? evidence?.[key];
  if (status.correlation_id !== credit.correlationId || status.status !== "SUCCESS" || status.type !== "transfer" || !status.updated_at || !Number.isFinite(Date.parse(status.updated_at)) ||
      (request?.confidential ?? d?.confidential) !== true || request?.recipient !== credit.recipient ||
      (request?.asset ?? request?.origin_asset) !== credit.asset || request?.amount !== credit.amount ||
      typeof field("intent_hash") !== "string" || !field("intent_hash") || credit.intentHash && field("intent_hash") !== credit.intentHash ||
      field("amount_out") !== undefined && field("amount_out") !== credit.amount)
    throw new Error("Provider evidence does not establish this exact incoming confidential credit");
  return { intentHash: field("intent_hash") as string, settledAt: status.updated_at! };
}

async function main() {
  const { values } = parseArgs({ options: {
    credit: { type: "string" }, receipt: { type: "string" }, "recorded-by": { type: "string" },
    "executor-stopped": { type: "boolean" }, "attest-receipt": { type: "boolean" },
  } });
  if (!values.credit || !values.receipt || !values["recorded-by"] || !values["executor-stopped"])
    throw new Error("Usage: record-incoming-credit --credit credit.json --receipt receipt-file --recorded-by operator --executor-stopped [--attest-receipt]. Stop the executor first; no funds are sent.");
  const credit = incomingCredit.parse({ ...JSON.parse(readFileSync(values.credit, "utf8")),
    recordedBy: values["recorded-by"], recordedAt: new Date().toISOString(), evidence: "operator-receipt" });
  if (credit.agent !== agentId()) throw new Error("Credit names another agent; use that agent's isolated ENV_FILE");
  const receipt = readFileSync(values.receipt);
  let held = true;
  // Use the same exclusion primitive without acquireMoneyLock's resolveUnsubmitted side effect.
  const release = await lockfile.lock(opsLog(), { realpath: false, retries: 0, stale: STALE_MS, onCompromised: () => { held = false; } });
  try {
    const unresolved = readOps().filter(blocksDispatch);
    if (unresolved.length) throw new UnresolvedOperations(unresolved);
    const agent = await api.getAgent(credit.agent);
    if (agent.wallet?.near_account_id !== credit.recipient) throw new Error("Credit does not name this agent's provider wallet");
    if (credit.correlationId) {
      const status = await api.getStatus(credit.correlationId);
      const proven = assertProviderCredit(credit, status);
      Object.assign(credit, proven, { evidence: "provider-status", providerOrigin: new URL(process.env.NEAR_INTENTS_AGENT_API_URL ?? "https://api.demo.agentsonintents.com").origin });
    } else if (!values["attest-receipt"]) throw new Error("No provider operation ID. Review the funding receipt and explicitly attest it with --attest-receipt; do not infer settlement from a balance.");
    if (!held) throw new Error("Money lock lost before credit recording");
    const result = recordIncomingCredit(credit, receipt);
    console.log(JSON.stringify({ created: result.created, evidence: result.credit.evidence, accountingOnly: true,
      notice: "Recorded funding evidence, not a new payment or an execution-journal repair. Re-read books before releasing any proposal hold." }));
  } finally { await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
