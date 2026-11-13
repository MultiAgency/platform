import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { liveFiles, offlineFiles, offlineEnvironment, requireLiveConfiguration } from "./test-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const live = process.argv[2] === "live";
const requested = process.argv.slice(3);
if (requested[0] === "--") requested.shift();
if (!["offline", "live"].includes(process.argv[2]) || live && requested.length) throw new Error("Usage: node scripts/test.mjs offline [test files] | live");
let env;
if (live) {
  const local = new URL("../.env", import.meta.url);
  env = { ...(existsSync(local) ? parseEnv(readFileSync(local, "utf8")) : {}), ...process.env, PROTO_TEST_MODE: "live" };
  // Match instance-specific configuration without importing application modules or printing values.
  if (env.ENV_FILE && env.ENV_FILE !== ".env") {
    for (const key of ["AGENT_ID", "AGENT_GRANT_TOKEN", "AGENT_GRANT_TOKEN_PENDING", "TREASURY_ACCOUNT", "AUTOPILOT"]) delete env[key];
    Object.assign(env, parseEnv(readFileSync(new URL(env.ENV_FILE, new URL("../", import.meta.url)), "utf8")));
  }
  requireLiveConfiguration(env);
} else env = offlineEnvironment();
const guard = fileURLToPath(new URL(live ? "../test/fixtures/live-network.cjs" : "../test/fixtures/offline-network.cjs", import.meta.url));
// Inherited by fixture subprocesses too. Never accept a caller's arbitrary preloads.
env.NODE_OPTIONS = `--require ${JSON.stringify(guard)}`;
const files = live ? liveFiles : offlineFiles(readdirSync(new URL("../test/", import.meta.url)), requested);
if (!files.length) throw new Error("No tests discovered");
// Offline suites start real SQLite/process fixtures. Run suite files serially so
// unrelated fixture startups do not consume each other's readiness deadlines.
// Races inside each suite still use real concurrent children and unchanged assertions.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...(!live ? ["--test-concurrency=1"] : []), ...files.map(name => `test/${name}`)], { cwd: root, env, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
