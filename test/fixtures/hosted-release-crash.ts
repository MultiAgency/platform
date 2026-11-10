import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { HostedAgents } from "../../src/gateway/hosted-agents.js";
const [name, point] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = ((from, to) => {
  rename(from, to);
  if (String(to).endsWith(`/${point}`) || String(to) === `.hosted/${point}`) process.kill(process.pid, "SIGKILL");
}) as typeof fs.renameSync;
syncBuiltinESMExports();
const registry = new HostedAgents(".hosted", []);
registry.release(name!, { agentId: "retained", at: "2026-11-10T00:00:00.000Z", archiveCorrelationId: null });
