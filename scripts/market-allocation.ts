/** Private operator CLI: owner signs outside this process. No sends or key generation. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { allocationMessageSchema, parseAllocation, signedAllocationSchema } from "../src/market/allocation-types.js";

const [action, file, ...extra] = process.argv.slice(2);
if (!file || extra.length || !["prepare", "commit", "status"].includes(action ?? ""))
  throw new Error("Usage: market-allocation.ts prepare|commit|status /private/review.json (records permission only; sends nothing)");
if (!process.env.ENV_FILE || !isAbsolute(process.env.ENV_FILE)) throw new Error("Select the original absolute hosted ENV_FILE");
const input = JSON.parse(readFileSync(file, "utf8"));
const { commitMarketAllocation, prepareMarketAllocation } = await import("../src/market/allocation.js");
if (action === "status") {
  const m = parseAllocation(signedAllocationSchema.parse(input));
  const { readMarketBindings, readOps } = await import("../src/ops.js");
  const { requestKey } = await import("../src/request-key.js");
  const targetKey = requestKey(m.target.actor, m.target.requestId);
  const source = readMarketBindings().find(b => b.idempotencyKey === m.sourceBindingKey);
  if (source?.allocation && (source.allocation.message !== input.message || source.allocation.signature !== input.signature))
    throw new Error("This is not the current retained allocation. Inspect the exact recorded target; do not continue from a superseded or different signed review.");
  const op = readOps().find(o => o.idempotencyKey === targetKey);
  console.log(JSON.stringify({ source: m.sourceBindingKey, target: targetKey,
    phase: op?.status === "SUCCESS" ? "paid" : op?.refused ? "refused" : op ? "unknown"
      : !source?.allocation ? "not_recorded" : Date.parse(parseAllocation(source.allocation).expiresAt) <= Date.now() ? "expired" : "allocated",
    currentAuthorityChecked: false, sends: 0, residualFundsRemainReserved: true }));
}
else if (action === "commit") console.log(JSON.stringify(await commitMarketAllocation(signedAllocationSchema.parse(input))));
else {
  if ("domain" in input || "nonce" in input) throw new Error("Preparation generates its own domain and nonce");
  const { domain: _domain, nonce: _nonce, ...review } = allocationMessageSchema.parse({
    domain: "multiagency.market-funding-disposition.v1", ...input, nonce: Buffer.alloc(32).toString("base64"),
  });
  console.log(JSON.stringify(await prepareMarketAllocation(review)));
}
