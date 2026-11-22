import { PublicError } from "../public-error.js";

/**
 * What happens next after a refusal before the claim, so an app can say it without parsing text:
 * - `now`: a race; trying again may pass at once.
 * - `later`: may clear without the owner (prices, quotes, the provider).
 * - `owner`: needs an owner action outside this proposal.
 * - `never`: this proposal can't pass; read it again, or propose anew.
 */
export const RETRY_CLASSES = ["now", "later", "owner", "never"] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

/** Every cause `proposals/execute` names on a `not_executable` refusal, with its fixed retry class. */
export const CAUSE_RETRY = {
  strategy_changed: "now",
  plan_expired: "now",
  stopping: "later",
  provider_warning: "later",
  floor: "later",
  unpriced: "later",
  /** `later` while the quote binds; `never` once the limit does (see `costLimit`). */
  cost_limit: "later",
  balance: "owner",
  policy_not_in_force: "owner",
  no_grant: "owner",
  cash_floor: "owner",
  outside_policy_assets: "never",
  policy_changed: "never",
  approval_mismatch: "never",
  record_changed: "never",
  claimed: "never",
  invalid_plan: "never",
} as const satisfies Record<string, RetryClass>;
export type CauseName = keyof typeof CAUSE_RETRY;

/** One problem of a refusal: the cause, its retry class, and the numbers a `cost_limit` carries. */
export type Cause = { cause: CauseName; retry: RetryClass; worstCostBps?: number; maxCostBps?: number };
/** A problem as the checks find it: the sentence a person reads, and its cause. */
export type Caused = { text: string; cause: Cause };

export const caused = (name: CauseName, text: string): Caused => ({ text, cause: { cause: name, retry: CAUSE_RETRY[name] } });

/**
 * A worst-case cost over the limit. The worst case is measured at the quote's minimum received, so it is the expected
 * cost plus the slippage margin. When the margin alone is over the limit, no quote can meet the limit and the proposal
 * can't pass: `never`; the owner proposes anew under another limit. Otherwise a better quote may come: `later`.
 * `worstCostBps` and `maxCostBps` are carried either way, so an app can tell which binds.
 */
export function costLimit(costBps: number, worstCostBps: number, maxCostBps: number, text: string): Caused {
  const limitBinds = Number.isFinite(worstCostBps) && Number.isFinite(costBps) && worstCostBps - costBps > maxCostBps;
  return { text, cause: { cause: "cost_limit", retry: limitBinds ? "never" : "later", worstCostBps, maxCostBps } };
}

/** A `PublicError` that also says why, cause by cause. Its message is the sentence the owner reads. */
export class CausedError extends PublicError {
  constructor(readonly causes: Caused[]) { super(causes.map(problem => problem.text).join("; ")); }
}

/** A string problem a caller supplies with no cause of its own. */
export const textOf = (problem: string | Caused) => typeof problem === "string" ? problem : problem.text;
export const causesOf = (problems: (string | Caused)[]): Cause[] => problems.flatMap(problem => typeof problem === "string" ? [] : [problem.cause]);
