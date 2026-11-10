import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ENV_FILE } from "./env.js";
import { PublicError } from "./public-error.js";
/** Re-read the durable marker: a different process may have released this executor. */
export function releaseMarker() {
  const env = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  if (!env.RELEASED_AT) return null;
  if (!Number.isFinite(Date.parse(env.RELEASED_AT))) throw new Error("Unreadable agent release marker");
  return { at: env.RELEASED_AT, archiveCorrelationId: env.RELEASED_ARCHIVE || null };
}
export class AgentReleased extends PublicError {
  readonly code = "agent_released";
  constructor(message = "This hosted agent was released. Its owner must sign a fresh setup before restoring it.") { super(message); }
}
export function assertNotReleased() { if (releaseMarker()) throw new AgentReleased(); }

/** Hosting restoration is separate from the owner's provider restore, including a market key's local send. */
export function assertCanSendAfterRelease() {
  assertNotReleased();
  const env = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  if (env.RESTORE_REQUIRED) throw new AgentReleased("Hosting was re-reserved, but the owner must unfreeze and restore the provider agent before it can send.");
}
