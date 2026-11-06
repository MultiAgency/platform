import lockfile from "proper-lockfile";
import { blocksDispatch, type Op, opsLog, readOps, resolveUnsubmitted } from "./ops.js";

/**
 * One money-moving run at a time, across every process (CLI, dashboard server, scripts). The lock
 * is a directory next to the ops log, created atomically; its holder refreshes it, so a crashed
 * holder's lock goes stale and can be taken over. Only the holder's `release` frees it.
 */
export type MoneyLock = { readonly held: boolean; release(): Promise<void> };

/** How long a crashed holder blocks others: its lock is stale once not refreshed for this long. */
export const STALE_MS = 10_000;

export class MoneyLockBusy extends Error {
  constructor() {
    super("Another money action is running (CLI, dashboard or script). Try again when it finishes.");
  }
}

export class UnresolvedOperations extends Error {
  constructor(readonly ops: Op[]) {
    // Reconcile resolves only operations with a provider ID; a lost provider reply leaves none and needs review.
    const polled = ops.filter((op) => op.correlationId), lost = ops.filter((op) => !op.correlationId);
    super(
      `${ops.length} earlier money action(s) have no proven outcome: ${ops.map((op) => op.idempotencyKey).join(", ")}. ` +
        (polled.length ? "`pnpm reconcile --poll` reads their outcomes. " : "") +
        (lost.length ? `${lost.map((op) => op.idempotencyKey).join(", ")} ${lost.length === 1 ? "has" : "have"} no operation ID, so reconcile cannot resolve ${lost.length === 1 ? "it" : "them"}: ` +
          "sends stay paused until reviewed (docs/enforcement.md, lost provider reply). " : "") +
        "Nothing new is sent meanwhile.",
    );
  }
}

/** Refused because this process is stopping: nothing was sent, and the action can be asked for again once it's back. */
export class Stopping extends MoneyLockBusy {
  constructor() {
    super();
    this.message = "This agent's server is stopping. Nothing was sent; try again once it's back.";
  }
}

/** This process's money locks held now, and whether it is stopping: a stop starts no send and waits for the one running. */
let heldHere = 0;
let stopping = false;
const idleWaiters = new Set<() => void>();

/** From now on this process takes no money lock and dispatches nothing more under one it holds. */
export function stopSending() {
  stopping = true;
}

/** Undoes `stopSending`, for tests that stop a process and go on in it; a stopping server never resumes. */
export function resumeSendingForTests() {
  stopping = false;
}

/** Refuses once this process is stopping: checked before claiming work, so a stop never uses up what wasn't started. */
export function assertNotStopping() {
  if (stopping) throw new Stopping();
}

/** Resolves true once this process holds no money lock, or false after `ms`: a send in flight is left to finish. */
export function moneyIdle(ms: number): Promise<boolean> {
  if (heldHere === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); idleWaiters.delete(done); resolve(true); };
    const timer = setTimeout(() => { idleWaiters.delete(done); resolve(false); }, ms);
    idleWaiters.add(done);
  });
}

/** Check again after asynchronous preflight: ownership may have been lost while awaiting it. */
export function assertMoneyLock(lock: MoneyLock) {
  if (!lock.held) throw new Error("Money actions need the money lock, held by this process");
}

/** A new action must not follow an unknown outcome, even within the same locked run. */
export function assertCanDispatch(lock: MoneyLock, initiatingKey?: string) {
  assertMoneyLock(lock);
  assertNotStopping();
  const unresolved = readOps().filter((op) => blocksDispatch(op) && op.idempotencyKey !== initiatingKey);
  if (unresolved.length) throw new UnresolvedOperations(unresolved);
}

/**
 * Takes the lock, then refuses to proceed while any earlier operation is unresolved: after a crash,
 * the same economic action must be reconciled under its original key, never sent again under a new one.
 * `reconcile` alone may take the lock with unresolved operations, to resolve them. Operations held
 * for the owner's approval don't block (see `isHeld`).
 */
export async function acquireMoneyLock({ reconcile = false }: { reconcile?: boolean } = {}): Promise<MoneyLock> {
  assertNotStopping();
  let held = true;
  let free: () => Promise<void>;
  try {
    free = await lockfile.lock(opsLog(), {
      realpath: false,
      stale: STALE_MS,
      retries: 0,
      // If another process took the lock over (we stalled past STALE_MS), we no longer own it:
      // stop sending rather than crash mid-operation.
      onCompromised: () => {
        held = false;
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ELOCKED") throw new MoneyLockBusy();
    throw error;
  }
  heldHere++;
  let counted = true;
  const uncount = () => {
    if (!counted) return;
    counted = false;
    if (--heldHere === 0) for (const done of [...idleWaiters]) done();
  };
  const lock: MoneyLock = {
    get held() {
      return held;
    },
    async release() {
      if (!held) return uncount();
      held = false;
      try { await free(); } finally { uncount(); }
    },
  };
  try {
    assertMoneyLock(lock);
    resolveUnsubmitted();
    if (!reconcile) {
      const unresolved = readOps().filter(blocksDispatch);
      if (unresolved.length > 0) throw new UnresolvedOperations(unresolved);
    }
  } catch (error) {
    await lock.release();
    throw error;
  }
  return lock;
}

export async function withMoneyLock<T>(run: (lock: MoneyLock) => Promise<T>): Promise<T> {
  const lock = await acquireMoneyLock();
  try {
    return await run(lock);
  } finally {
    await lock.release();
  }
}
