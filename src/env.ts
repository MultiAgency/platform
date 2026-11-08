import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import lockfile from "proper-lockfile";
import { writeAtomic } from "./synced.js";

/**
 * This instance's settings file. The default instance keeps everything in `.env`. Another
 * instance (a second agent beside the CLI's) names its own with `ENV_FILE`: shared keys such as
 * the API keys still come from `.env`, but the agent-specific ones start empty and come only from
 * its file, so it never runs, or overwrites, the default instance's agent.
 */
// An inherited approve-only restriction cannot be lifted by instance settings or runtime saves.
const executorDisabled = process.env.EXECUTOR === "off";
export const ENV_FILE = process.env.ENV_FILE || ".env";
// Schedule enablement belongs to this instance too. Inheriting it can start a second agent
// whose owner authorized its strategy but never enabled its schedule.
const INSTANCE_KEYS = ["AGENT_ID", "AGENT_GRANT_TOKEN", "AGENT_GRANT_TOKEN_PENDING", "TREASURY_ACCOUNT", "AUTOPILOT"];
if (ENV_FILE !== ".env") {
  for (const key of INSTANCE_KEYS) delete process.env[key];
  if (existsSync(ENV_FILE)) Object.assign(process.env, parseEnv(readFileSync(ENV_FILE, "utf8")));
}

/**
 * Saves values to this instance's settings file, replacing earlier ones, and applies them to this
 * process. The dashboard and the CLIs share the agent through it, beside the API key. It holds the
 * grant token, so it is readable only by its owner, and is replaced whole: a crash mid-write leaves
 * the previous file, never a truncated one. A symlinked file is updated at its target.
 * All writers lock that target before reading. A competing update refuses for retry rather than
 * blocking the event loop or overwriting a stale snapshot. Coordination is single-host only.
 */
export function saveEnv(values: Record<string, string>) {
  const file = existsSync(ENV_FILE) ? realpathSync(ENV_FILE)
    : join(realpathSync(dirname(resolve(ENV_FILE))), basename(ENV_FILE));
  let release: () => void;
  try { release = lockfile.lockSync(file, { realpath: false, retries: 0, stale: 60_000 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED")
      throw new Error("Settings are being updated by another process; retry this change.");
    throw error;
  }
  try {
    const kept = (existsSync(file) ? readFileSync(file, "utf8") : "")
      .split("\n")
      .filter((line) => !Object.keys(values).some((key) => line.startsWith(`${key}=`)))
      .join("\n")
      .trimEnd();
    const added = Object.entries(values).map(([key, value]) => `${key}=${value}`);
    writeAtomic(file, `${[kept, ...added].filter(Boolean).join("\n")}\n`, 0o600);
    Object.assign(process.env, values);
  } finally { release(); }
}

/**
 * The agent this process runs, read on use: the server starts before onboarding creates one,
 * and onboarding or `pnpm create-agent` / `pnpm issue-grant` save it to the instance's settings file.
 */
export function agentId() {
  const id = process.env.AGENT_ID;
  if (!id) throw new Error("AGENT_ID is not set: create an agent first");
  return id;
}

/**
 * Whether this instance sends money actions for its agent. One host is an agent's executor; another
 * instance of the same agent (the owner's local dashboard, while the executor runs elsewhere) sets
 * `EXECUTOR=off`: it still reads, and approves as the owner, but never sends or reconciles.
 */
export const executes = () => !executorDisabled && process.env.EXECUTOR !== "off";
