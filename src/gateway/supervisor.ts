import type { ChildProcess } from "node:child_process";
import { Clock, Effect, Exit, Fiber, Option, Scope } from "effect";

/** Owns only children started by this gateway; closing its scope cancels every restart. */
export class Supervisor<T extends { name: string }> {
  private scope = Scope.makeUnsafe("parallel");
  private names = new Map<string, { fiber: Fiber.Fiber<void>; closing?: Promise<void> }>();
  private children = new Map<string, { closed: boolean }>();
  private stopping = false;
  private closing?: Promise<boolean>;
  private signal: NodeJS.Signals = "SIGTERM";
  private clean = true;
  constructor(private launch: (agent: T) => ChildProcess, private options = {
    initialDelay: 5_000, maxDelay: 300_000, stableAfter: 60_000, grace: 30_000, killGrace: 5_000,
  }, private clock?: Clock.Clock) {}

  start(agent: T) {
    if (this.stopping || this.names.has(agent.name)) return;
    const run = this.clock ? Effect.provideService(this.run(agent), Clock.Clock, this.clock) : this.run(agent);
    const fiber = Effect.runSync(Effect.forkIn(run, this.scope, { startImmediately: true }));
    this.names.set(agent.name, { fiber });
  }

  private run(agent: T) {
    const self = this;
    return Effect.gen(function* () {
      let delay = self.options.initialDelay;
      while (!self.stopping) {
        const started = yield* Clock.currentTimeMillis;
        yield* Effect.scoped(Effect.gen(function* () {
          const resource = yield* Effect.acquireRelease(Effect.sync(() => {
            // Register close before yielding: an interrupted acquisition must still own its child.
            try {
              const child = self.launch(agent);
              child.on("error", () => {});
              const resource = { child, closed: false, done: Promise.resolve() };
              self.children.set(agent.name, resource);
              resource.done = new Promise<void>(resolve => child.once("close", () => { resource.closed = true; resolve(); }));
              return resource;
            } catch { return undefined; }
          }), resource => Effect.gen(function* () {
            if (!resource || resource.closed) return;
            try { resource.child.kill(self.signal); } catch { self.clean = false; }
            const wait = Effect.interruptible(Effect.promise(() => resource.done));
            if (Option.isSome(yield* Effect.timeoutOption(wait, self.options.grace))) return;
            self.clean = false;
            try { resource.child.kill("SIGKILL"); } catch { self.clean = false; }
            yield* Effect.timeoutOption(wait, self.options.killGrace);
          }));
          if (resource) yield* Effect.promise(() => resource.done);
        }));
        if (self.stopping) return;
        delay = (yield* Clock.currentTimeMillis) - started < self.options.stableAfter
          ? Math.min(delay * 2, self.options.maxDelay) : self.options.initialDelay;
        console.error(`Agent server ${agent.name} stopped; restarting in ${delay / 1000} s`);
        yield* Effect.sleep(delay);
      }
    });
  }

  /** Interrupts both the child and its backoff; the name remains reserved until cleanup finishes. */
  stopOne(name: string): Promise<void> {
    const running = this.names.get(name);
    if (!running) return Promise.resolve();
    return running.closing ??= Effect.runPromise(Fiber.interrupt(running.fiber)).then(() => {
      if (this.children.get(name)?.closed === false) throw new Error("The agent child did not confirm shutdown; release stays unfinished.");
      this.children.delete(name);
      if (this.names.get(name) === running) this.names.delete(name);
    });
  }

  stop(signal: NodeJS.Signals = "SIGTERM"): Promise<boolean> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.signal = signal;
    return this.closing = Effect.runPromise(Scope.close(this.scope, Exit.void)).then(() => this.clean);
  }
}

/** Direct Node loading keeps the supervised PID identical to the application PID. */
export const workerArguments = (...args: string[]) => ["--import", import.meta.resolve("tsx"), ...args];
