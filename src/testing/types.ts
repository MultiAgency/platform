import type { AppBase } from "../contract/app-client.js";
import type { AppScope } from "../contract/app-consent.js";
import type { OwnerOutput } from "../contract/owner-client.js";

/**
 * `@multiagency/sdk/testing`'s public types. They name only contract types, so the package's declarations carry nothing
 * of the platform's server; the implementation (src/testing/payout-double.ts) is bundled with the platform's own pure
 * `authorize` and policy digest.
 */

/** A provider policy as `overview` shows it. */
export type DoublePolicy = NonNullable<OwnerOutput<"overview">["policy"]["policy"]>;
/** The policy's provider state: in force only when `APPLIED` and synchronized (and not frozen). */
export type DoublePolicyState = { status?: "NONE" | "SIGNED" | "APPLIED" | "FAILED"; synced?: boolean };
/** The grant this agent's executor holds, or null for none. A revoked or expired one is held but not live. */
export type DoubleGrant = { label: string; expiresAt?: string; revoked?: boolean } | null;
/** How a held or approved payment ends at the provider. */
export type DoubleOutcome = "SUCCESS" | "FAILED" | "REFUNDED";

export type PayoutDoubleOptions = {
  /** The app's Organization and agent, as `app.agent(organization, agent)` names them. Defaults `org_1` and `payout`. */
  organization?: string;
  agent?: string;
  /** Agreed payees of the default policy (the platform's payout template: confidential USDC, held for the owner). */
  payees?: string[];
  /** A whole policy instead of the template. */
  policy?: DoublePolicy;
  /** Default: a live `payout` grant for a day. */
  grant?: DoubleGrant;
  /** The confidential balance per asset, raw units. Default: 100 USDC. */
  balances?: Record<string, string>;
  /** The live consent's scopes. Default: `read` and `payout`. */
  scopes?: AppScope[];
};

/** One payout request as the double recorded it, for a test's assertions. */
export type DoubleRequest = {
  requestId: string;
  method: "transfer" | "withdraw";
  request: Record<string, unknown>;
  /** What the agent's journal holds: the provider status last read, or the refusal code. */
  status: string | null;
  refused: string | null;
  correlationId: string | null;
  /** The provider's own status now, which the journal learns on the next `payouts/status` or `held` read. */
  providerStatus: string | null;
};

export type PayoutDouble = {
  /** Pass these three to `appClient`: every call is answered in process, nothing reaches a network. */
  base: AppBase;
  credential: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  organization: string;
  agent: string;
  /** The policy's revision and mandate digest, as `overview` answers them: a request's `expectedPolicy`. */
  reviewedPolicy(): { revision: number; digest: string };
  /** The owner's signed policy changes (revision + 1), or its provider state alone (`state`). */
  setPolicy(policy: DoublePolicy, state?: DoublePolicyState): void;
  setPolicyState(state: DoublePolicyState): void;
  setGrant(grant: DoubleGrant): void;
  /** The confidential balance of `asset`, raw units. */
  setBalance(asset: string, raw: string): void;
  /** The owner's vote on a held request: approved, the provider moves it on (`PROCESSING`); rejected, it ends `FAILED`. */
  vote(requestId: string, verdict: "approve" | "reject"): void;
  /** The provider ends an approved (or unheld) payment. */
  settle(requestId: string, outcome?: DoubleOutcome): void;
  /** The provider accepts the next send but its answer is lost: that request reads `unknown` and blocks the agent's sends. */
  loseNextAnswer(): void;
  /** Named accounts exist on NEAR and are registered on every token unless declared otherwise here. */
  recipients: {
    absent(account: string): void;
    unregistered(account: string, asset: string): void;
    /** The chain doesn't answer (`true`) until set back (`false`). */
    unchecked(value: boolean): void;
  };
  /** The owner's consent ends: every call answers `forbidden` with `code: "no_consent"`. */
  revokeConsent(): void;
  requests(): DoubleRequest[];
  /** Calls the double doesn't model (answered 501, which the client reports as `unavailable` or `unknown`). */
  unmodelled(): string[];
};

export type PayoutDoubleFactory = (options?: PayoutDoubleOptions) => PayoutDouble;
