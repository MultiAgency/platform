import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test("gateway waits for managed children to stop before reporting a clean exit", { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-lifecycle-"));
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ host: "fixture.test", agents: [
    { name: "fixture", owner: "owner.near", port: 9898, envFile: ".env.fixture" },
  ] }));
  const child = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("test/fixtures/gateway-lifecycle.ts")], {
    cwd: dir, env: { ...process.env, PORT: "0", SESSION_SECRET: "synthetic-session-".repeat(3) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout!.on("data", chunk => diagnostics += chunk);
  child.stderr!.on("data", chunk => diagnostics += chunk);
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill("SIGKILL");
    if (existsSync(join(dir, "child-ready"))) {
      try { process.kill(Number(readFileSync(join(dir, "child-ready"), "utf8")), "SIGKILL"); } catch {}
    }
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 4_000;
  while (!existsSync(join(dir, "child-ready")) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(join(dir, "child-ready")), `synthetic child did not start (exit ${child.exitCode}, signal ${child.signalCode}): ${diagnostics}`);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  assert.ok(existsSync(join(dir, "child-stopped")), "gateway must not exit before its child finishes shutdown");
});
