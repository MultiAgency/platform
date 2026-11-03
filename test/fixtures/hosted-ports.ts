// Hosted reservations take the first free loopback port from 9000 (src/gateway/hosted-agents.ts). Two gateways reserving
// at once, as test files running in parallel do, can pick the same port: one child then can't bind it and its agent never
// answers. In production one gateway owns a host. Test files that start hosted children hold this lock for their whole
// run, so they take turns. A holder that died leaves its pid behind and the lock is taken over.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const lock = join(tmpdir(), "multiagency-hosted-ports.lock");

const dead = (pid: number) => {
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};

export async function holdHostedPorts() {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    let holder = NaN;
    try { holder = Number(readFileSync(join(lock, "pid"), "utf8")); } catch { /* its holder is still writing it */ }
    if (Number.isInteger(holder) && dead(holder)) rmSync(lock, { recursive: true, force: true });
    else if (Date.now() > deadline) throw new Error(`Hosted ports still held by pid ${holder} after 5 minutes (${lock})`);
    else await setTimeout(200);
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
  process.once("exit", () => rmSync(lock, { recursive: true, force: true }));
}
