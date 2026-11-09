/** Saved plan contract; shared by pure checks, storage and execution. */
export type PlannedAction =
  | { type: "swap"; from: string; to: string; amount: string; amountOut: string; minAmountOut: string; costBps: number }
  | { type: "shield"; asset: string; amount: string };

export type Snapshot = {
  agentId: string;
  policyRevision: number | null;
  /** `mandateDigest` of the policy in force: the mandate the plan was proposed under. */
  policyDigest: string | null;
  /** `strategyDigest` of the owner's strategy: the targets and limits the plan was proposed under. */
  strategyDigest: string;
  /** Public and confidential balance per asset, raw. */
  balances: Record<string, { public: string; confidential: string }>;
};

/**
 * What proposed the plan; its actions are logged under this kind. `steward` names plans the LLM steward proposed
 * before it left the platform (SDK 0.5.5); stored ones keep it, and nothing saves a new one.
 */
export type PlanSource = "steward" | "rebalance" | "external" | "proposal";

export type Plan = Snapshot & {
  id: string;
  source: PlanSource;
  createdAt: string;
  expiresAt: string;
  instruction: string;
  actions: PlannedAction[];
  /** The owner-approved proposal this plan executes: it runs only as that proposal (src/proposals/service.ts). */
  proposalId?: string;
};
