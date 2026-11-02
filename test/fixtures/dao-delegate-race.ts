// Offline process fixture: real preparation, locks, persistence and delegate encoding.
// Only provider/RPC observations are replaced. The barrier is after delegateWaiting,
// at ownerFunded, before nonce lookup and durable preparation.
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { Near } from "near-kit";
import lockfile from "proper-lockfile";
import { api } from "../../src/api.js";
import { rawKey } from "../../src/nep413.js";
import { prepare, reconcileOwnerIntents } from "../../src/owner-intents.js";

const [id, publicKey, barrier] = process.argv.slice(2) as [string, string, string];
const owner = { type: "near", account_id: rawKey(publicKey).toString("hex"), public_key: publicKey };
let loseLock: (() => void) | undefined;
if (barrier === "lose-lock") {
  const acquire = lockfile.lock;
  lockfile.lock = async (path, options) => {
    const release = await acquire(path, options);
    if (path.includes(".delegate-")) loseLock = () => options?.onCompromised?.(new Error("Fixture ownership loss"));
    return release;
  };
}
globalThis.fetch = async () => { throw new Error("Network forbidden in delegate race fixture"); };
Object.assign(Near.prototype, {
  view: async (_contract: string, method: string) => {
    if (method === "derived_public_key") return publicKey;
    if (method === "get_policy" || method === "get_last_proposal_id") return null;
    throw new Error(`Unexpected view: ${method}`);
  },
  getAccount: async () => {
    writeFileSync(`${id}.checked`, "passed pending-delegate check");
    // Held until the test releases it; the test's spawn timeout bounds the wait. A deadline here would let a slow
    // run give up the lock and pass the contender through, which reads as a lock failure.
    if (barrier === "wait") while (!existsSync("release")) await setTimeout(10);
    return {};
  },
});
Object.assign(Object.getPrototypeOf(new Near({ network: "mainnet" }).rpc), {
  getAccessKey: async () => ({ nonce: Number(process.argv[5] ?? 41), permission: "FullAccess" }),
  getStatus: async () => {
    loseLock?.();
    return { sync_info: { latest_block_height: 1000 } };
  },
});
Object.assign(api, {
  submitIntent: async () => { throw new Error("Signature submission forbidden in fixture"); },
  getStatus: async (correlationId: string) => {
    if (barrier === "recover-unknown") throw new Error("Fixture status unavailable");
    return { correlation_id: correlationId, agent_id: process.env.AGENT_ID,
      status: correlationId === "payout" ? "PROCESSING" : barrier === "recover-failed" ? "FAILED" : "SUCCESS" };
  },
  generateIntent: async (request: { type: string }) => ({
    type: request.type, correlation_id: id, preview: { summary: "Offline freeze fixture" },
    expires_at: new Date(Date.now() + 600_000).toISOString(), signer: owner,
    intent: { standard: "nep366", payload: { receiverId: "outlayer.near", actions: [{ type: "FunctionCall",
      params: { methodName: "freeze_wallet", args: { wallet: id }, gas: "30000000000000", deposit: "1" },
    }] } },
  }),
});
try {
  if (barrier.startsWith("recover-")) console.log(JSON.stringify({ recovered: await reconcileOwnerIntents() }));
  else {
    const result = await prepare({ type: "agent_freeze" }, "dao");
    console.log(JSON.stringify({ prepared: result.correlationId }));
  }
} catch (error) {
  console.log(JSON.stringify({ refused: error instanceof Error ? error.message : String(error) }));
}
