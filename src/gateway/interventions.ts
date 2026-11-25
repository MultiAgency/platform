import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendSynced } from "../synced.js";

/**
 * The gateway's record of calls that may act on an agent (`isIntervention`), from every route that forwards one: an
 * owner's session, a machine credential and an app under its owner's consent. The unattended-run report judges "no
 * operator interventions" from it (docs/unattended-run.md). Calls made on a host directly (CLI, shell) are not in it.
 */
const INTERVENTIONS = join(".evidence", "interventions.jsonl");

export type InterventionCall = { at: string; account: string; agent: string; path: string };

/** Appends one call before it is forwarded. It throws when the line can't be written, so the call isn't run. */
export function recordIntervention(entry: InterventionCall & Record<string, unknown>) {
  mkdirSync(".evidence", { recursive: true });
  appendSynced(INTERVENTIONS, entry);
}

/**
 * Recorded calls since `since`, oldest first, and the line numbers that don't parse. An unreadable line may have been a
 * call, so it is counted, not skipped: a report can't claim none. It can't be attributed to an agent, so every reader
 * is told it exists. Each call carries only its time, caller, agent and procedure.
 */
export function readInterventions(since: string) {
  const calls: InterventionCall[] = [];
  const corrupt: number[] = [];
  const text = existsSync(INTERVENTIONS) ? readFileSync(INTERVENTIONS, "utf8") : "";
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const { at, account, agent, path } = JSON.parse(line) as InterventionCall;
      calls.push({ at, account, agent, path });
    } catch { corrupt.push(index + 1); }
  }
  return { calls: calls.filter((call) => call.at >= since), corrupt };
}
