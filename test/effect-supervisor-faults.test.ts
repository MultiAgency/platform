import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Supervisor } from "../src/gateway/supervisor.js";

for (const throws of [false, true]) {
  test(`shutdown stays bounded without close confirmation; signaling throws=${throws}`, { timeout: 1500 }, async () => {
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), { kill(signal: string) {
      signals.push(signal);
      if (throws) throw new Error("synthetic-private-process-detail");
      return false;
    } });
    const supervisor = new Supervisor(() => child as unknown as ChildProcess,
      { initialDelay: 20, maxDelay: 80, stableAfter: 1000, grace: 20, killGrace: 20 });
    supervisor.start({ name: "fixture" });
    assert.equal(await supervisor.stop(), false);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });
}

test("a per-agent stop refuses to confirm release when child shutdown is unknown", { timeout: 1500 }, async () => {
  const child = Object.assign(new EventEmitter(), { kill() { return false; } });
  const supervisor = new Supervisor(() => child as unknown as ChildProcess,
    { initialDelay: 20, maxDelay: 80, stableAfter: 1000, grace: 20, killGrace: 20 });
  supervisor.start({ name: "fixture" });
  await assert.rejects(supervisor.stopOne("fixture"), /did not confirm shutdown/);
  assert.equal(await supervisor.stop(), false);
});
