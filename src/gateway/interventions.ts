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

/**
 * An ISO 8601 time with its zone (`Z` or an offset), as UTC ISO, the form the record writes; null for anything else. The
 * record is compared as text, so a time in another form would sort wrongly and hide calls; one without a zone would be
 * read in some local time.
 */
export function utcTime(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Appends one call before it is forwarded. It throws when the line can't be written, so the call isn't run. */
export function recordIntervention(entry: InterventionCall & Record<string, unknown>) {
  mkdirSync(".evidence", { recursive: true });
  appendSynced(INTERVENTIONS, entry);
}

/**
 * Recorded calls since `since` (`utcTime`; absent or unreadable, the whole record), and the line numbers that can't be
 * read as a call: unparseable, or missing its time, caller, agent or procedure. Such a line may have been a call, so it
 * is counted, not skipped: a report can't claim none. It can't be attributed to an agent, so every reader is told it
 * exists. Each call carries only its time (as UTC ISO), caller, agent and procedure.
 */
export function readInterventions(since: string) {
  const from = utcTime(since) ?? "";
  const calls: InterventionCall[] = [];
  const corrupt: number[] = [];
  const text = existsSync(INTERVENTIONS) ? readFileSync(INTERVENTIONS, "utf8") : "";
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry: Partial<Record<keyof InterventionCall, unknown>> | null = null;
    try { entry = JSON.parse(line); } catch { /* counted below */ }
    const at = typeof entry?.at === "string" ? utcTime(entry.at) : null;
    if (!entry || at === null || typeof entry.account !== "string" || typeof entry.agent !== "string" || typeof entry.path !== "string") {
      corrupt.push(index + 1); continue;
    }
    if (at >= from) calls.push({ at, account: entry.account, agent: entry.agent, path: entry.path });
  }
  return { calls, corrupt };
}
