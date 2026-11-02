import { api } from "../api.js";
import { agentId } from "../env.js";
import { liveGrant } from "../grants.js";
import { loadStrategy } from "../strategy.js";
import { grantApproves, strategyDigest } from "../strategy-digest.js";
import type { Plan } from "./model.js";

/**
 * Whether a caller's plans need the strategy-bound grant: an app (`app:`) or a Treasury machine credential (`machine:`),
 * either of which runs on strategy settings an app may have saved. The owner's own session doesn't.
 */
export const strategyGrantRequired = (actor: string | undefined) => !!actor && /^(app|machine):/.test(actor);

/**
 * Why an app or machine credential may not execute this plan, or nothing: the strategy it was planned under must be the
 * one saved now and the one the owner's live grant binds by digest (`treasury:<suffix>`). An app with `treasury` may save
 * strategy settings (docs/enforcement.md, "Treasury proposals"); only the owner's grant makes them count. Run under the
 * money lock, before the plan's claim.
 */
export async function strategyGrantProblems(plan: Plan): Promise<string[]> {
  const strategy = loadStrategy();
  if (strategyDigest(strategy) !== plan.strategyDigest) return ["the owner's strategy changed since the plan"];
  const grant = liveGrant(await api.listGrants(agentId()), process.env.AGENT_GRANT_TOKEN);
  if (!grant || !grant.label.startsWith("treasury:") || !grantApproves(grant.label, strategy))
    return ["the agent's live grant doesn't bind the saved strategy: the owner signs a grant for it before an app or a machine credential executes plans"];
  return [];
}
