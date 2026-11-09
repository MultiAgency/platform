import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { depositAddress } from "../agent.js";
import { api } from "../api.js";
import { accountExists, confidentialSetup, daoPayees, describeTreasury, fundingTransaction } from "../chain.js";
import { status as autopilotStatus, tick } from "../autopilot.js";
import { ticks } from "../evidence.js";
import { exportRunLog } from "../run-log-export.js";
import { agentId, executes, saveEnv } from "../env.js";
import { executePlan } from "../plans.js";
import { strategyGrantProblems, strategyGrantRequired } from "../planning/strategy-grant.js";
import { ExternalPlanInput, prepareExternalPlan } from "../planning/external.js";
import { ASSETS } from "../policy.js";
import { PublicError } from "../public-error.js";
import { MIN_EVERY_MIN, Strategy } from "../strategy-digest.js";
import { enableSchedule, saveReviewedStrategy, setLegacySchedule, stopSchedule } from "../strategy-controls.js";
import { readStrategyStatus } from "../strategy-status.js";
import { rebalance, sweep } from "../treasury.js";
import { os, owner } from "./base.js";
import { readOutput } from "./read-output.js";
import { run, account, units } from "../contract/inputs.js";
import { checkHostedTreasury } from "../hosted-binding.js";

export const treasuryRoutes = {
  /** Readiness observations do not authorize or start an operation. */
  strategy: {
    get: owner.strategy.get.use(readOutput("strategy/get")).handler(() => readStrategyStatus()),
    save: os.input(z.strictObject({ strategy: Strategy, expectedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }))
      .handler(({ input }) => saveReviewedStrategy(input.strategy, input.expectedDigest)),
  },
  /**
   * The account the agent works for, set by the owner: any NEAR account, or a DAO voting through
   * Trezu. A DAO is confidential when the chain shows it set up for confidential intents (chain.ts
   * `confidentialSetup`); any other account never is. A confidential treasury pays on its private
   * side, so its public proposals show no real payees; it gets no payee candidates from the chain.
   */
  treasury: {
    get: os.use(readOutput("treasury/get")).handler(async () => {
      const id = process.env.TREASURY_ACCOUNT;
      if (!id) return null;
      const treasury = await describeTreasury(id);
      const confidential = treasury.dao !== null && await confidentialSetup(id);
      return { ...treasury, confidential, payees: treasury.dao && !confidential ? await daoPayees(id) : [] };
    }),
    link: os.input(z.object({ accountId: account })).handler(async ({ input }) => {
      checkHostedTreasury(input.accountId);
      if (!(await accountExists(input.accountId))) throw new PublicError("That NEAR account does not exist. Check the account name; nothing was linked.");
      saveEnv({ TREASURY_ACCOUNT: input.accountId });
    }),
    unlink: os.handler(() => { checkHostedTreasury(""); saveEnv({ TREASURY_ACCOUNT: "" }); }),
    /** A fresh deposit address and the one transaction that pays into it, for the treasury to sign. */
    fund: os.input(z.object({ asset: z.enum(["USDC", "NEAR"]), amount: units })).handler(async ({ input }) => {
      const deposit = await depositAddress(input.asset === "USDC" ? ASSETS.USDC : ASSETS.wNEAR);
      return { deposit, transaction: fundingTransaction(input.asset, deposit.address, input.amount) };
    }),
  },
  /** The agent working on its own (src/autopilot.ts): off until the owner turns it on. */
  autopilot: {
    get: os.use(readOutput("autopilot/get")).handler(() => autopilotStatus()),
    set: os
      .input(z.object({ on: z.boolean(), everyMin: z.number().int().min(MIN_EVERY_MIN).max(24 * 60), maxUsd: z.number().int().min(0).max(1_000_000), expectedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional() }))
      .handler(async ({ input }) => { await setLegacySchedule(input); return autopilotStatus(); }),
    enable: os.input(z.strictObject({ expectedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }))
      .handler(({ input }) => enableSchedule(input.expectedDigest)),
    stop: os.handler(() => stopSchedule()),
    /** "Run now": one autopilot pass under its usual guard and grant check; an app's actor is recorded in the tick's evidence. */
    tick: os.handler(({ context }) => tick("operator", context.actor?.startsWith("app:") ? context.actor : undefined)),
    /** Every tick's evidence line since `since`: what the scheduler saw and did (src/evidence.ts). */
    evidence: os.input(z.object({ since: z.iso.datetime().optional() })).use(readOutput("autopilot/evidence")).handler(({ input }) => ticks(input.since)),
    /** A private recording from this executor's existing records; never starts or reconciles a tick. */
    log: os.input(z.strictObject({ tickId: z.string().min(1).max(200).optional() })).use(readOutput("autopilot/log"))
      .handler(({ input }) => {
        if (!executes()) throw new ORPCError("PRECONDITION_FAILED", { message: "Export run logs from this agent's executor." });
        return exportRunLog(process.cwd(), agentId(), input.tickId, () => api.getTokens({ signal: AbortSignal.timeout(5_000) }));
      }),
  },
  /** Previews a rebalance and saves it as a plan; `executePlan` runs it. */
  rebalance: owner.rebalance.handler(() => rebalance()),
  /** Quotes the caller’s exact swaps and saves the complete plan without submitting funds. */
  externalPlan: os.input(ExternalPlanInput).handler(({ input }) => prepareExternalPlan(input)),
  sweep: os.input(run).handler(({ input }) => sweep(input)),
  /**
   * Executes a saved plan (including an external agent's chosen swaps) exactly as previewed, or refuses if anything
   * material changed. An app's call (`app:`, under `treasury-execute`) or a machine credential's (`machine:`) runs only
   * under a grant binding the plan's strategy, checked under the lock before the claim: the owner's signature, not an
   * app's saved settings, lets a strategy act.
   */
  executePlan: owner.executePlan.handler(({ input, context }) =>
    executePlan(input.planId, undefined, strategyGrantRequired(context.actor) ? { beforeClaim: strategyGrantProblems } : {})),
};
