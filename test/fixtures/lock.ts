// Child process for lock.test.ts, run in a temporary directory:
//   hold          take the money lock and keep it until killed
//   try           try to take it; print acquired / busy / unresolved
//   crash-after-log  take it, log a request as dispatch does before sending, then die mid-operation
//   stop          hold it while the process stops sending; print each step
import { acquireMoneyLock, assertCanDispatch, MoneyLockBusy, moneyIdle, stopSending, UnresolvedOperations } from "../../src/lock.js";
import { record } from "../../src/ops.js";

const mode = process.argv[2];
const outcome = (run: () => unknown) => { try { run(); return "allowed"; } catch (error) { return error instanceof MoneyLockBusy ? "busy" : `error ${error}`; } };
if (mode === "stop") {
  const lock = await acquireMoneyLock();
  stopSending();
  console.log(`dispatch ${outcome(() => assertCanDispatch(lock))}`);
  console.log(`acquire ${await acquireMoneyLock().then(() => "allowed", error => error instanceof MoneyLockBusy ? "busy" : `error ${error}`)}`);
  console.log(`idle while held ${await moneyIdle(200)}`);
  const idle = moneyIdle(5_000);
  await lock.release();
  console.log(`idle once released ${await idle}`);
  process.exit(0);
}
try {
  const lock = await acquireMoneyLock();
  if (mode === "hold") {
    console.log(`held ${process.pid}`);
    setInterval(() => {}, 1000);
  } else if (mode === "crash-after-log") {
    record({ at: new Date().toISOString(), idempotencyKey: "swap:crashed", kind: "rebalance", method: "swap", request: { origin_asset: "a", destination_asset: "b", amount: "1" } });
    process.kill(process.pid, "SIGKILL");
  } else {
    console.log("acquired");
    await lock.release();
  }
} catch (error) {
  console.log(error instanceof MoneyLockBusy ? "busy" : error instanceof UnresolvedOperations ? "unresolved" : `error ${error}`);
}
