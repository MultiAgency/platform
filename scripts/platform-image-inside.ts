// Runs inside the `platform` image, with --network none, no volume and no credentials: started by
// scripts/check-platform-image.mjs, which mounts this file at /app/platform-image-inside.ts. It checks the image as
// built, not the repository: the packaged bytes, two boots of the real entrypoint and config, the platform smoke checks
// against each boot, and that every state directory and file present before the boots is unchanged after them.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platformChecks } from "/app/src/smoke-platform.ts";

const manifest = JSON.parse(readFileSync("/app/release-manifest.json", "utf8")) as { files: Record<string, string> };
let hashed = 0;
for (const [path, hash] of Object.entries(manifest.files)) {
  if (!/^(src\/|scripts\/|web\/|deploy\/|package\.json$|pnpm-|tsconfig\.json$)/.test(path)) continue;
  assert.equal(createHash("sha256").update(readFileSync(join("/app", path))).digest("hex"), hash, path);
  hashed++;
}
assert.ok(hashed > 0, "the manifest names packaged files");

// Requests reach the gateway as they do behind the hosting edge: for the configured host, on port 80. The gateway
// refuses app access and the confirm page for any other host (421).
const host = (JSON.parse(readFileSync("/app/deploy/platform.json", "utf8")) as { host: string }).host;
appendFileSync("/etc/hosts", `127.0.0.1 ${host}\n`);

const data = mkdtempSync("/tmp/platform-image-"), state = join(data, "state");
mkdirSync(state);
// The canonical state directories (docs/operations.md); test/state-directories.test.ts keeps this list equal to it.
const kept = [".ops", ".invoices", ".owner-intents", ".strategy", ".plans", ".evidence", ".inbox", ".agreements", ".notify", ".work-orders", ".hosted", ".agent-connections", ".machine-auth", ".app-access", ".proposals"];
for (const dir of kept) { mkdirSync(join(state, dir)); writeFileSync(join(state, dir, "preserve"), `retained ${dir}`); }
writeFileSync(join(state, ".env"), "retained settings");
const before = new Map<string, string>();
(function record(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) record(path);
    else before.set(path, readFileSync(path, "utf8"));
  }
})(state);

// The shipped operator command must load from canonical state cwd, not depend on /app as cwd.
const fundingUsage = spawnSync("/app/node_modules/.bin/tsx", ["/app/scripts/market-funding-proof.ts"], {
  cwd: state, env: { PATH: process.env.PATH, HOME: "/tmp" }, encoding: "utf8", timeout: 15_000,
});
assert.notEqual(fundingUsage.status, 0);
assert.match(fundingUsage.stderr, /Usage: tsx scripts\/market-funding-proof.ts/);
assert.doesNotMatch(fundingUsage.stderr, /NEAR_INTENTS_AGENT_API_KEY is not set|ERR_MODULE_NOT_FOUND/);
const allocationUsage = spawnSync("/app/node_modules/.bin/tsx", ["/app/scripts/market-allocation.ts"], {
  cwd: state, env: { PATH: process.env.PATH, HOME: "/tmp" }, encoding: "utf8", timeout: 15_000,
});
assert.notEqual(allocationUsage.status, 0);
assert.match(allocationUsage.stderr, /Usage: market-allocation.ts/);
assert.doesNotMatch(allocationUsage.stderr, /NEAR_INTENTS_AGENT_API_KEY is not set|ERR_MODULE_NOT_FOUND/);

let child: ChildProcess | undefined;
const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(resolve => child!.once("exit", resolve));
  child.kill("SIGTERM"); await exited;
};
try {
  for (let boot = 1; boot <= 2; boot++) {
    child = spawn("/app/deploy/platform-entrypoint.sh", [], { env: {
      PATH: process.env.PATH, HOME: "/tmp", DATA_DIR: data, PORT: "80", NODE_ENV: "production",
      DASHBOARD_FILE: "/app/deploy/platform.json", SESSION_SECRET: "offline-image-session-secret-123456789",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stderr!.on("data", chunk => { logs += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`boot ${boot}: startup timeout\n${logs}`)), 20_000);
      child!.stdout!.on("data", chunk => { logs += chunk; if (String(chunk).includes("on port 80,")) { clearTimeout(timer); resolve(); } });
      child!.once("exit", code => { clearTimeout(timer); reject(new Error(`boot ${boot}: gateway exited ${code}\n${logs}`)); });
    });
    const failed = (await platformChecks(new URL(`http://${host}/`))).filter(check => !check.ok);
    assert.deepEqual(failed, [], `boot ${boot}: platform checks`);
    await stop();
    for (const [path, content] of before) assert.equal(readFileSync(path, "utf8"), content, `boot ${boot} changed ${path}`);
    for (const dir of kept) assert.ok(statSync(join(state, dir)).isDirectory(), `boot ${boot} removed ${dir}`);
  }
  console.log(`PASS: ${hashed} packaged hashes; two boots of the entrypoint pass the platform checks; ${before.size} state files and ${kept.length} state directories unchanged.`);
} finally { await stop(); rmSync(data, { recursive: true, force: true }); }
