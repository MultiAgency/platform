import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export const liveFiles = ["execute-plan.test.ts"];
export function offlineFiles(entries, requested = []) {
  const available = entries.filter(name => name.endsWith(".test.ts") && !liveFiles.includes(name)).sort();
  if (!requested.length) return available;
  const selected = requested.map(name => name.replace(/^test\//, ""));
  for (const name of selected) if (!available.includes(name)) throw new Error(`Not a registered offline test: ${name}`);
  return [...new Set(selected)];
}
const systemKeys = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR"];

/** Never inherit application credentials, instance settings, proxies or NODE_OPTIONS offline. */
/** @returns {Record<string, string>} */
export function offlineEnvironment(parent = process.env) {
  const env = Object.fromEntries(systemKeys.filter(key => parent[key] !== undefined).map(key => [key, parent[key]]));
  return { ...env, ...parseEnv(readFileSync(new URL("../test/offline.env", import.meta.url), "utf8")), PROTO_TEST_MODE: "offline" };
}

export function requireLiveConfiguration(env) {
  const required = ["NEAR_INTENTS_AGENT_API_KEY", "AGENT_ID", "AGENT_GRANT_TOKEN"];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Live tests require ${missing.join(", ")}. No tests were started.`);
}
