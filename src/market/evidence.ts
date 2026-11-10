import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentId } from "../env.js";
import { appendSynced, mkdirSynced } from "../synced.js";

/**
 * What the market answered for each paid hire: the task id, the only way back to a paid result, and the task's states
 * as read. Evidence beside the journal, never in it: nothing reads this to decide a send or a payment's outcome, which
 * is the chain's. The name doesn't end in `.jsonl`, which journal checks treat as an agent journal.
 */

const Entry = z.object({ idempotencyKey: z.string(), at: z.string(), handle: z.string(), taskId: z.string(), state: z.string() });
export type MarketEvidence = z.infer<typeof Entry>;

const log = () => {
  mkdirSynced(".ops");
  return join(".ops", `${agentId()}.market.ndjson`);
};

export const recordTask = (entry: Omit<MarketEvidence, "at">) => appendSynced(log(), { at: new Date().toISOString(), ...entry });

/** Each hire's latest evidence, by its operation's key. An unreadable line is skipped: this decides nothing. */
export function latestTasks(): Map<string, MarketEvidence> {
  const file = log();
  const latest = new Map<string, MarketEvidence>();
  if (!existsSync(file)) return latest;
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try {
      const entry = Entry.safeParse(JSON.parse(text));
      if (entry.success) latest.set(entry.data.idempotencyKey, entry.data);
    } catch {}
  }
  return latest;
}
