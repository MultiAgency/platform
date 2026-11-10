import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Supervisor, workerArguments } from "../src/gateway/supervisor.js";

const options = { initialDelay: 20, maxDelay: 80, stableAfter: 1000, grace: 500, killGrace: 500 };
const child = (code: string) => spawn(process.execPath, ["-e", code], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
const ready = `process.on('SIGTERM', () => process.exit(0)); process.send('ready'); setInterval(() => {}, 1000);`;

test("one child per name; crash restarts once, shutdown cancels pending restart", async t => {
  const children: ChildProcess[] = [];
  const supervisor = new Supervisor(() => { const c = child(ready); children.push(c); return c; }, options);
  t.after(() => supervisor.stop());
  supervisor.start({ name: "one" }); supervisor.start({ name: "one" });
  await once(children[0]!, "message");
  assert.equal(children.length, 1);
  const firstClosed = once(children[0]!, "close"); children[0]!.kill("SIGKILL"); await firstClosed;
  for (let i = 0; i < 100 && children.length < 2; i++) await delay(10);
  assert.equal(children.length, 2);
  const secondClosed = once(children[1]!, "close"); children[1]!.kill("SIGKILL"); await secondClosed;
  assert.equal(await supervisor.stop(), true);
  await delay(100);
  supervisor.start({ name: "two" });
  assert.equal(children.length, 2, "neither pending timer nor new start can spawn after shutdown");
});

test("failed spawn is contained and backs off rather than crashing the gateway", async t => {
  let attempts = 0;
  const supervisor = new Supervisor(() => { attempts++; return spawn('/nonexistent/proto-fixture'); }, options);
  t.after(() => supervisor.stop());
  supervisor.start({ name: "missing" });
  for (let i = 0; i < 100 && attempts < 2; i++) await delay(10);
  assert.ok(attempts >= 2);
  await supervisor.stop();
  const stopped = attempts; await delay(100); assert.equal(attempts, stopped);
});

test("shutdown during startup cannot start a replacement", async () => {
  let launches = 0;
  const supervisor = new Supervisor(() => { launches++; return child(ready); }, options);
  supervisor.start({ name: "starting" });
  assert.equal(await supervisor.stop(), true);
  await delay(100);
  assert.equal(launches, 1);
});

test("unresponsive child is killed and shutdown is reported as forced", async t => {
  let processChild!: ChildProcess;
  const supervisor = new Supervisor(() => processChild = child(`process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`), { ...options, grace: 50 });
  t.after(() => supervisor.stop());
  supervisor.start({ name: "unresponsive" });
  await once(processChild, "message");
  const first = supervisor.stop();
  assert.equal(supervisor.stop(), first, "concurrent stop shares completion");
  assert.equal(await first, false);
  assert.equal(processChild.signalCode, "SIGKILL");
});


test("production node loader supervises the worker PID itself through forced shutdown", async t => {
  let worker!: ChildProcess;
  const supervisor = new Supervisor(() => worker = spawn(process.execPath,
    workerArguments("-e", "process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000)"),
    { stdio: ["ignore", "ignore", "ignore", "ipc"] }), { ...options, grace: 50 });
  t.after(() => supervisor.stop());
  supervisor.start({ name: "actual-loader" });
  const [pid] = await once(worker, "message");
  assert.equal(pid, worker.pid, "supervised PID must be the application, not a launcher");
  assert.equal(await supervisor.stop(), false);
  assert.throws(() => process.kill(pid as number, 0), { code: "ESRCH" });
});
test("shutdown signals all children promptly and preserves the requested signal", async t => {
  const children: ChildProcess[] = [];
  const supervisor = new Supervisor(() => {
    const c = child(`process.on('SIGINT', () => process.send('stopping')); process.send('ready'); setInterval(()=>{},1000);`);
    children.push(c); return c;
  }, { ...options, grace: 150 });
  t.after(() => supervisor.stop());
  supervisor.start({ name: "a" }); supervisor.start({ name: "b" });
  await Promise.all(children.map(c => once(c, "message")));
  let closed = 0;
  for (const c of children) c.once("close", () => { closed++; });
  const signals = children.map(c => once(c, "message"));
  const stopping = supervisor.stop("SIGINT");
  assert.deepEqual((await Promise.all(signals)).map(([message]) => message), ["stopping", "stopping"]);
  assert.equal(closed, 0, "all children receive shutdown before waiting for any one to terminate");
  assert.equal(await stopping, false);
  assert.ok(children.every(c => c.signalCode === "SIGKILL"));
});


test("stopping one agent cancels only its restart loop and permits a later restore", async t => {
  const children = new Map<string, ChildProcess[]>();
  const supervisor = new Supervisor((agent: { name: string }) => {
    const c = child(ready); children.set(agent.name, [...children.get(agent.name) ?? [], c]); return c;
  }, options);
  t.after(() => supervisor.stop());
  supervisor.start({ name: "released" }); supervisor.start({ name: "retained" });
  await Promise.all([...children.values()].map(cs => once(cs[0]!, "message")));
  await supervisor.stopOne("released");
  await delay(150);
  assert.equal(children.get("released")!.length, 1);
  assert.notEqual(children.get("released")![0]!.exitCode, null);
  assert.equal(children.get("retained")![0]!.exitCode, null);
  supervisor.start({ name: "released" });
  await once(children.get("released")![1]!, "message");
  assert.equal(children.get("released")!.length, 2);
});
