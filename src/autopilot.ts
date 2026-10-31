import { progressRecorder } from "./run-progress.js";
import type { ProgressEvent } from "./run-progress-schema.js";
import { LocalRefusal } from "./agent.js";
import { api } from "./api.js";
import { agentId, saveEnv } from "./env.js";
import { post, readInbox } from "./inbox.js";
import { liveGrant } from "./grants.js";
import { MoneyLockBusy } from "./lock.js";
import { blocksDispatch, provenRefusal } from "./ops.js";
import { executePlan } from "./plans.js";
import { context, newTickId, observe, recordEnd, recordStart, type TickEnd, type TickStart } from "./evidence.js";
import { ageMinutes, recover } from "./recover.js";
import { loadStrategy, saveStrategy } from "./strategy.js";
import { grantApproves, type Strategy, strategyDigest, strategyLabelSuffix } from "./strategy-digest.js";
import { blockingWarnings, rebalance, sweep, warnedCodes, warnedReason } from "./treasury.js";

/**
 * The agent working on its own: each tick sweeps public balances into the confidential one, then
 * previews a rebalance and executes it only if its swaps are worth no more than the owner's
 * auto-execute limit. A larger plan becomes an inbox item asking the owner to preview it: plans
 * expire in minutes, so none is left waiting. Every step is the same code the dashboard runs, under
 * the same lock, plan checks and policy; the policy's caps and budget stay the hard boundary.
 *
 * Off until the owner turns it on, and with a limit of $0 by default: shields can run under the
 * authorized strategy, while swaps wait for the owner. Every send requires the strategy the
 * owner signed: this server's live grant must carry its digest in its label (`grantApproves`), so
 * editing the strategy file changes nothing the agent does alone until the owner signs a new grant.
 */

/** `everyMin` and `maxUsd` (whole dollars) are part of the strategy, inside its digest; on/off is not: turning off is always safe. */
type Settings = { on: boolean } & Strategy["autopilot"];

export function settings(): Settings {
  return { on: process.env.AUTOPILOT === "on", ...loadStrategy().autopilot };
}

export function saveSettings({ on, everyMin, maxUsd }: Settings) {
  saveStrategy({ ...loadStrategy(), autopilot: { everyMin, maxUsd } });
  saveEnv({ AUTOPILOT: on ? "on" : "" });
}

const lastRun = () => readInbox().find((e) => e.level === "run")?.at ?? null;

export function status() {
  const s = settings();
  const last = lastRun();
  const next = s.on ? new Date(Math.max(Date.now(), (last ? new Date(last).getTime() : 0) + s.everyMin * 60_000)).toISOString() : null;
  return { ...s, lastRun: last, nextRun: next };
}

/**
 * Whether this server's live grant is the owner's approval of the strategy in force. `authorize` refuses
 * every autopilot send without it; checked first so that such a tick waits for the owner instead of
 * recording refusals.
 */
async function mandateApproved(strategy: Strategy) {
  const grant = liveGrant(await api.listGrants(agentId()), process.env.AGENT_GRANT_TOKEN);
  return grant !== undefined && grantApproves(grant.label, strategy);
}

let running = false;

type Found = Pick<TickEnd, "plan" | "steps" | "shields" | "rejected" | "refusal">;

/**
 * One tick, never two at once: a scheduled tick and "Run now" share this guard. Every tick, skipped
 * ones included, writes a start and an end evidence line (src/evidence.ts). A tick whose start can't
 * be written doesn't run: unrecorded work is never done. A missing end means interrupted or unknown.
 */
export async function tick(trigger: TickStart["trigger"]): Promise<string> {
  const id = newTickId();
  const at = new Date().toISOString();
  const found: Found = { plan: null, steps: [], shields: [], rejected: [], refusal: null };
  const schedule = { ...settings(), lastRun: lastRun() };
  // Claimed before the first await, so two ticks can't both pass.
  const busy = running;
  running = true;
  try {
    try {
      recordStart({ id, at, trigger, schedule, ...(busy ? {} : { progressVersion: 1 as const }), ...(await context()) });
    } catch (error) {
      const outcome = `Not run: the tick's evidence could not be recorded (${error instanceof Error ? error.message : String(error)}).`;
      post("warn", outcome);
      return outcome;
    }
    const recorder = progressRecorder(".", agentId(), id);
    const end = (outcome: string, before: TickEnd["before"], after: TickEnd["after"]) => {
      try {
        recordEnd({ id, endedAt: new Date().toISOString(), before, after, ...found, outcome, ...(recorder.failed ? { progressIncomplete: true } : {}) });
      } catch (error) {
        post("warn", `Tick ${id} ran, but its evidence end could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
      return outcome;
    };
    if (busy) return end("Skipped: a tick is already running.", { error: "another tick was running" }, { error: "another tick was running" });
    const progress = recorder.record;
    progress({ type: "STEP_STARTED", stepName: "balances-before" });
    const before = await observe();
    progress({ type: "STEP_FINISHED", stepName: "balances-before" });
    const outcome = await run(found, progress);
    progress({ type: "STEP_STARTED", stepName: "balances-after" });
    const after = await observe();
    progress({ type: "STEP_FINISHED", stepName: "balances-after" });
    return end(outcome, before, after);
  } finally {
    if (!busy) running = false;
  }
}

/** What a tick does, also recorded in the inbox. */
async function run(found: Found, progress: (event: ProgressEvent) => void): Promise<string> {
  const onSubmitted = (method: "swap" | "shield" | "transfer" | "unshield", correlationId: string) =>
    progress({ type: "CUSTOM", name: "treasury.observation", value: { stage: "submission", method, correlationId } });
  // The ceiling and the grant must describe the same strategy as the plan. An owner can
  // replace and authorize a strategy while this tick awaits provider observations.
  const strategy = loadStrategy();
  const expectedStrategy = strategyDigest(strategy);
  const { maxUsd } = strategy.autopilot;
  const strategyChanged = () => strategyDigest(loadStrategy()) !== expectedStrategy;
  const done = (text: string) => post("run", text).text;
  const changed = () => done("Skipped: the strategy changed during this tick. Review it again on the next run.");
  try {
    const { policy } = await api.getPolicy(agentId());
    if (!policy) return done("Skipped: the agent's policy is not applied yet.");
    if (policy.frozen) return done("Skipped: the agent is frozen.");
    // Reads the status of each action without a proven outcome; resends nothing, which is a person's call.
    // What still blocks is exactly what blocks the money lock (`blocksDispatch`).
    progress({ type: "STEP_STARTED", stepName: "recovery" });
    const unresolved = (await recover()).filter((r) => blocksDispatch({ ...r.op, status: r.status ?? r.op.status }));
    progress({ type: "STEP_FINISHED", stepName: "recovery" });
    if (unresolved.length > 0) {
      const list = unresolved.map((r) => `${r.op.idempotencyKey} (${r.outcome}, ${ageMinutes(r.op)} min old)`).join(", ");
      post("warn", `Money actions without a proven outcome: ${list}. Check them under Activity; the autopilot waits until then.`);
      return done("Skipped: unresolved money actions.");
    }

    const report: string[] = [];
    // Every send, a sweep's shield included, needs the owner's grant for the strategy in force.
    const approved = await mandateApproved(strategy);
    if (strategyChanged()) return changed();
    if (!approved) report.push("sweep left for the owner: the owner's grant doesn't approve this strategy");
    else {
      progress({ type: "STEP_STARTED", stepName: "sweep" });
      for await (const event of sweep({ execute: true, autopilot: true, onSubmitted })) {
        if (event.type !== "shield") continue;
        report.push(`shielded ${event.asset}: ${event.status}`);
        found.shields.push({ asset: event.asset, status: event.status, correlationId: event.correlationId });
        if (event.status !== "SUCCESS") post("warn", `A sweep shield of ${event.asset} ended ${event.status} (${event.correlationId}).`);
      }

      progress({ type: "STEP_FINISHED", stepName: "sweep" });
    }

    if (strategyChanged()) return changed();

    if (policy.actions.includes("swap")) {
      progress({ type: "STEP_STARTED", stepName: "planning" });
      let usd = 0;
      let planId: string | undefined;
      let plannedStrategy: string | undefined;
      let legs: { usd: number }[] = [];
      const warned: string[] = [];
      for await (const event of rebalance()) {
        if (event.type === "plan") legs = event.legs;
        if (event.type === "quote") warned.push(...blockingWarnings(event));
        if (event.type === "saved") {
          planId = event.plan.id;
          plannedStrategy = event.plan.strategyDigest;
          found.plan = { id: event.plan.id, usd: 0, legs: event.plan.actions.flatMap((a) => a.type === "swap"
            ? [{ from: a.from, to: a.to, amount: a.amount, amountOut: a.amountOut, minAmountOut: a.minAmountOut, costBps: a.costBps }] : []) };
          usd = legs.reduce((sum, leg, i) => sum + (event.steps[i] === undefined ? 0 : leg.usd), 0);
          found.plan.usd = usd;
        }
      }
      progress({ type: "STEP_FINISHED", stepName: "planning" });
      if (strategyChanged() || (plannedStrategy !== undefined && plannedStrategy !== expectedStrategy)) return changed();
      if (warned.length) {
        // The same warnings ask the owner once, not every tick and not again once dismissed: rule warnings don't clear
        // until the policy or strategy changes, and each tick's report still names them.
        const ask = `The provider's dry run warned about rebalance swaps (${warnedCodes(warned)}), so they were not sent. Change the policy or the strategy, or wait if the warning clears.`;
        if (!readInbox().some((e) => e.text === ask)) post("action", ask);
        if (planId) report.push(`swaps left out: ${warnedReason(warned)}`);
      }
      if (!planId) report.push(!legs.length ? "no rebalance legs meet the minimum size"
        : warned.length ? `rebalance skipped: ${warnedReason(warned)}` : "rebalance skipped: all proposed swaps exceed the cost limit");
      else if (usd > maxUsd) {
        post("action", `A rebalance of $${usd.toFixed(2)} is above the $${maxUsd.toFixed(2)} auto-execute limit. Preview and execute it from Automations.`);
        report.push(`rebalance of $${usd.toFixed(2)} left for the owner`);
      } else if (!approved) {
        post(
          "action",
          `A rebalance of $${usd.toFixed(2)} is within the limit, but the owner's grant doesn't approve the strategy in force. Issue a new grant from Policy: its label, treasury:${strategyLabelSuffix(loadStrategy())}, approves it.`,
        );
        report.push(`rebalance of $${usd.toFixed(2)} left for the owner: the owner's grant doesn't approve this strategy`);
      } else {
        progress({ type: "STEP_STARTED", stepName: "execution" });
        for await (const event of executePlan(planId, undefined, { autopilot: true, onSubmitted })) {
          if (event.type === "rejected") {
            found.rejected.push(...event.problems);
            report.push(`rebalance not executed: ${event.problems.join("; ")}`);
            continue;
          }
          found.steps.push({ index: event.index, status: event.status, correlationId: event.correlationId, failureCode: event.failureCode ?? null });
          report.push(`step ${event.index + 1}: ${event.status}`);
          if (event.status !== "SUCCESS") post("warn", `Autopilot step ${event.index + 1} ended ${event.status} (${event.correlationId || "no correlation id"}).`);
        }
        progress({ type: "STEP_FINISHED", stepName: "execution" });
      }
    }
    return done(report.length ? report.join(", ") : "Nothing to do.");
  } catch (error) {
    if (error instanceof MoneyLockBusy) return done("Skipped: another money action was running.");
    found.refusal = error instanceof LocalRefusal ? error.code : provenRefusal(error) ?? null;
    const message = error instanceof Error ? error.message : String(error);
    post("warn", `The autopilot stopped: ${message}`);
    return done(`Failed: ${message}`);
  }
}

let timer: NodeJS.Timeout | undefined;

/** Checks every minute whether a tick is due, so settings saved from the dashboard apply at once. */
export function startAutopilot() {
  timer ??= setInterval(() => {
    const deferred = (error: unknown) => console.error("Scheduled tick deferred:", error instanceof Error ? error.message : "unknown error");
    try {
      const { on, nextRun } = status();
      if (on && nextRun && new Date(nextRun).getTime() <= Date.now()) void tick("schedule").catch(deferred);
    } catch (error) {
      deferred(error);
    }
  }, 60_000);
  timer.unref();
}
