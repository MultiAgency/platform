import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicError } from "../public-error.js";
import { claimSynced, mkdirSynced } from "../synced.js";
import type { Plan, PlannedAction, PlanSource, Snapshot } from "./model.js";

const PLAN_TTL_MS = 5 * 60_000;
const DIR = ".plans";

const digest = (plan: Plan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

export function savePlan(
  base: Snapshot,
  source: PlanSource,
  instruction: string,
  actions: PlannedAction[],
  now = new Date(),
  proposalId?: string,
): Plan {
  const plan: Plan = {
    ...base,
    id: randomUUID(),
    source,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    instruction,
    actions,
    ...(proposalId && { proposalId }),
  };
  mkdirSynced(DIR);
  writeFileSync(join(DIR, `${plan.id}.json`), JSON.stringify({ plan, sha256: digest(plan) }, null, 2));
  return plan;
}

export function loadPlan(id: string): Plan {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Not a plan id");
  const file = join(DIR, `${id}.json`);
  if (!existsSync(file)) throw new PublicError("This plan was not found. Prepare a new plan; nothing was sent.");
  const { plan, sha256 } = JSON.parse(readFileSync(file, "utf8")) as { plan: Plan; sha256: string };
  if (digest(plan) !== sha256) throw new Error(`Plan ${id} was modified after it was saved`);
  return plan;
}

/** Marks a plan executed durably before any action; false if already claimed. Atomic across processes. */
export function claimPlan(id: string): boolean {
  return claimSynced(join(DIR, `${id}.executed`));
}
