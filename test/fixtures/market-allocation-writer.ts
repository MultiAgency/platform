// The last admission step after mocked owner/provider verification: real money lock and append/fsync.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { acquireMoneyLock } from "../../src/lock.js";
import { recordMarketAllocation } from "../../src/ops.js";
const [input, phase] = process.argv.slice(2);
try {
  const lock = await acquireMoneyLock();
  try {
    if (phase === "before") process.kill(process.pid, "SIGKILL");
    recordMarketAllocation(JSON.parse(readFileSync(input!, "utf8")));
    if (phase === "after") process.kill(process.pid, "SIGKILL");
    if (phase === "hold") {
      writeFileSync(join(dirname(input!), "allocation-held"), "held");
      while (!existsSync(join(dirname(input!), "allocation-release"))) await setTimeout(10);
    }
    console.log(JSON.stringify({ recorded: true }));
  } finally { await lock.release(); }
} catch (error) { console.log(JSON.stringify({ recorded: false, reason: error instanceof Error ? error.message : "refused" })); }
