// Child process for spending-limits-race.test.ts: one sender among several on the same host, sharing the working
// directory (the journal and the money lock) and a simulated provider kept in SQLite (`provider.db`).
//   budget <usdc-raw>  a treasury swap of that much USDC into wNEAR, under a USD budget and no per-asset caps
//   asset <usdc-raw>   a payout of that much USDC, under per-asset caps and no USD budget
// It prints `ready`, waits for the `go` file, then takes the money lock (retrying while another sender holds it) and
// dispatches once. Its last line is a JSON result: { outcome: "settled" | "refused" | "error", code?, busy }.
//
// The simulated provider is deliberately not atomic, the case OutLayer's custody reference describes as best effort
// (cumulative counters dependent on coordinator-supplied usage, recorded post-settlement): admission reads usage, yields,
// and refuses only if that stale usage plus the request is over the limit; usage is charged only once the operation
// settles. Anything that keeps admissions within the limit has to come from this side of the boundary.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AgentApiError, type Policy } from "@near-intents-agent-api/sdk";
import { authorityFixture, balanceView, policyView, timedPrices } from "./authority.js";
import { api } from "../../src/api.js";
import { dispatch, sendRefusal } from "../../src/agent.js";
import { MoneyLockBusy, withMoneyLock } from "../../src/lock.js";
import { ASSETS, payoutPolicy, treasuryPolicy } from "../../src/policy.js";

const [mode, amount] = process.argv.slice(2) as ["budget" | "asset", string];
if (mode !== "budget" && mode !== "asset" || !/^\d+$/.test(amount ?? "")) throw new Error("usage: spending-race.ts budget|asset <raw>");
process.env.AGENT_GRANT_TOKEN = "ngt_test";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The signed limits each case binds on: $25 a day for swaps; 50 USDC a day and 25 per payment for payouts. */
const BUDGET_USD = 25;
const policy: Policy = mode === "budget"
  ? { ...treasuryPolicy, limits: {}, budget: { daily_usd: String(BUDGET_USD), weekly_usd: null, monthly_usd: null } }
  : { ...payoutPolicy(["payee.near"]), owner_approval: false, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null } };
const dailyCap = BigInt(policy.limits.daily?.[ASSETS.USDC] ?? "0");

const db = new DatabaseSync("provider.db");
db.exec("PRAGMA busy_timeout = 10000");
db.exec(`CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, amount TEXT NOT NULL,
  usd TEXT NOT NULL, status TEXT NOT NULL, charged INTEGER NOT NULL DEFAULT 0)`);
/** What the provider has charged so far: only settled operations count, as with usage recorded post-settlement. */
const charged = () => db.prepare("SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS raw, COALESCE(SUM(CAST(usd AS REAL)), 0) AS usd FROM operations WHERE charged = 1")
  .get() as { raw: number; usd: number };
const refused = (code: string) => new AgentApiError(403, { errors: [{ status: "403", code, title: code }] } as never);

/** Admission: a check against the usage read before yielding, then the operation recorded unsettled. */
async function admit(raw: string, key: string) {
  const usage = charged();
  await sleep(25 + Math.random() * 25);
  const usd = Number(raw) / 1e6; // USDC at $1
  if (mode === "budget" && usage.usd + usd > BUDGET_USD) throw refused("spend_budget_exceeded");
  // policy_denied is how the provider was observed refusing a cumulative cap (monthly, 2026-10-13, docs/mainnet-log.md).
  if (mode === "asset" && BigInt(usage.raw) + BigInt(raw) > dailyCap) throw refused("policy_denied");
  const id = `op_${key}`;
  db.prepare("INSERT INTO operations (id, idempotency_key, amount, usd, status) VALUES (?, ?, ?, ?, 'PROCESSING')").run(id, key, raw, String(usd));
  return { correlation_id: id };
}

Object.assign(api, {
  ...authorityFixture(mode === "budget" ? "treasury" : "payout"),
  getPolicy: async () => policyView(policy),
  getTokens: async () => timedPrices([
    { asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 },
    { asset_id: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24, price: 2 },
  ]),
  getBalances: async (_id: string, { source }: { source: string }) => balanceView(source, [{ asset_id: ASSETS.USDC, balance_raw: "1000000000" }]),
  forGrant: () => ({
    swap: async (_agent: string, request: { amount: string }, { idempotencyKey }: { idempotencyKey: string }) => admit(request.amount, idempotencyKey),
    transfer: async (_agent: string, request: { amount: string }, { idempotencyKey }: { idempotencyKey: string }) => admit(request.amount, idempotencyKey),
  }),
  // Settlement charges usage, once.
  getStatus: async (correlation_id: string) => {
    await sleep(25);
    db.prepare("UPDATE operations SET status = 'SUCCESS', charged = 1 WHERE id = ?").run(correlation_id);
    return { correlation_id, status: "SUCCESS", details: null };
  },
});

console.log("ready");
while (!existsSync("go")) await sleep(5);
let busy = 0;
const action = mode === "budget"
  ? { method: "swap" as const, request: { origin_asset: ASSETS.USDC, destination_asset: ASSETS.wNEAR, amount, confidential: true } as never }
  : { method: "transfer" as const, request: { asset: ASSETS.USDC, amount, recipient: "payee.near", confidential: true } };
for (;;) {
  try {
    await withMoneyLock((lock) => dispatch(lock, mode === "budget" ? "swap" : "payout", action));
    console.log(JSON.stringify({ outcome: "settled", busy }));
  } catch (error) {
    if (error instanceof MoneyLockBusy) { busy++; await sleep(5 + Math.random() * 10); continue; }
    const code = sendRefusal(error);
    console.log(JSON.stringify(code ? { outcome: "refused", code, busy } : { outcome: "error", message: String(error), busy }));
  }
  break;
}
db.close();
