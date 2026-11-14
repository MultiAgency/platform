import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { depositAddress } from "./agent.js";
import { agentId, executes } from "./env.js";
import { provenRefusal } from "./ops.js";
import { PublicError } from "./public-error.js";
import { appendSynced, mkdirSynced } from "./synced.js";

/**
 * Deposit addresses a caller asks for under its own `requestId` (CONTEXT.md, "Deposit request"). The request's identity
 * is derived from the agent, the caller and the `requestId`, and is the provider's idempotency key. The request is recorded before
 * it is sent and its answer after, so a lost reply stays one unknown request under its original key and is never
 * replaced by another address. An address allocation moves no funds, so it stays out of the money journal: an unknown
 * one blocks only its own `requestId`, never a send.
 */

const deposit = z.object({ correlationId: z.string(), address: z.string(), memo: z.string().nullable(),
  minAmount: z.string().nullable(), expiresAt: z.string().nullable() });
const line = z.discriminatedUnion("event", [
  z.object({ event: z.literal("requested"), key: z.string(), at: z.string(), requestId: z.string(), asset: z.string() }),
  z.object({ event: z.literal("allocated"), key: z.string(), at: z.string(), deposit }),
  z.object({ event: z.literal("refused"), key: z.string(), at: z.string(), code: z.string() }),
]);
type Recorded = { asset: string; requestedAt: string; deposit?: z.infer<typeof deposit>; refused?: string };

/** Beside the journal, not in it; the name doesn't end in `.jsonl`, which journal checks treat as an agent journal. */
function log() {
  mkdirSynced(".ops");
  return join(".ops", `${agentId()}.deposit-requests.ndjson`);
}

/** The agent is part of the identity: one caller's `requestId` on two agents must never reach the provider under one key. */
export const depositKey = (actor: string, requestId: string) =>
  `deposit:${createHash("sha256").update(`${agentId()}\n${actor}\n${requestId}`).digest("hex").slice(0, 32)}`;

/**
 * What was recorded under `key`. A line that doesn't parse is skipped: a torn `requested` line was never sent, and a
 * torn answer leaves its request unknown. Fields this build doesn't know are ignored, so a later build's lines still read.
 */
function find(key: string): Recorded | undefined {
  const file = log();
  if (!existsSync(file)) return undefined;
  let found: Recorded | undefined;
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (!text.trim()) continue;
    let parsed: z.infer<typeof line>;
    try { parsed = line.parse(JSON.parse(text)); } catch { continue; }
    if (parsed.key !== key) continue;
    if (parsed.event === "requested") found ??= { asset: parsed.asset, requestedAt: parsed.at };
    else if (found && !found.deposit && !found.refused) {
      if (parsed.event === "allocated") found.deposit = parsed.deposit;
      else found.refused = parsed.code;
    }
  }
  return found;
}

const callerOf = (actor: string | undefined) => {
  if (!actor) throw new PublicError("A deposit request needs the caller's identity from the gateway. Nothing was asked.");
  // Requests are recorded only beside the executor's journal: an approve-only copy would answer `not_found` for one it can't see.
  if (!executes()) throw new PublicError("This copy only approves: ask the agent's executor about deposit requests. Nothing was asked.");
  return actor;
};
const refusal = (code: string, message: string) => new ORPCError("CONFLICT", { message, data: { kind: "refused", code } });

/** Requests this process is sending, each until its answer is recorded: a concurrent repeat waits instead of reading none. */
const sending = new Map<string, Promise<unknown>>();

/**
 * Asks for the address once. Asked again, it answers the recorded address and asks the provider nothing; while the
 * first answer is unknown or was refused, it refuses. Another asset under the same `requestId` is refused.
 */
export async function requestDeposit(actor: string | undefined, input: { requestId: string; asset: string }) {
  const key = depositKey(callerOf(actor), input.requestId);
  // No await unless one is being sent: from here to `sending.set` nothing yields, so two callers can't both find none.
  const first = sending.get(key);
  if (first) await first.catch(() => {});
  const prior = find(key);
  if (prior) {
    if (prior.asset !== input.asset) throw refusal("request_conflict", "This requestId was already used for another asset. Nothing was asked.");
    if (prior.deposit) return { requestId: input.requestId, ...prior.deposit };
    if (prior.refused) throw refusal("deposit_request_refused", `The provider refused this deposit request (${prior.refused}) and allocated nothing. Ask under a new requestId.`);
    throw refusal("deposit_request_unknown", "An address was asked for under this requestId and no answer was recorded. Nothing was asked again; depositStatus reports the request.");
  }
  appendSynced(log(), { event: "requested", key, at: new Date().toISOString(), requestId: input.requestId, asset: input.asset });
  const answered = depositAddress(input.asset, key).then(allocated => {
    appendSynced(log(), { event: "allocated", key, at: new Date().toISOString(), deposit: allocated });
    return { requestId: input.requestId, ...allocated };
  }, error => {
    // Only a recognized non-execution response proves nothing was allocated; any other failure leaves the request unknown.
    const code = provenRefusal(error);
    if (code) appendSynced(log(), { event: "refused", key, at: new Date().toISOString(), code });
    throw error;
  }).finally(() => sending.delete(key));
  sending.set(key, answered);
  return answered;
}

/** The request's recorded outcome, from this agent's own records. Asks the provider nothing and allocates nothing. */
export function depositStatus(actor: string | undefined, requestId: string) {
  const found = find(depositKey(callerOf(actor), requestId));
  if (!found) return { requestId, state: "not_found" as const };
  const { asset, requestedAt } = found;
  if (found.deposit) return { requestId, state: "ready" as const, asset, requestedAt, deposit: found.deposit };
  if (found.refused) return { requestId, state: "refused" as const, asset, requestedAt, code: found.refused };
  return { requestId, state: "unknown" as const, asset, requestedAt };
}
