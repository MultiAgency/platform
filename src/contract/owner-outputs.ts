/**
 * Output (return value) schemas of the owner-facing oRPC procedures served by `src/router.ts`.
 * Every object is a `z.looseObject`, so validating an output never strips a field the server added:
 * the fields declared are the ones whose type was read from the handler. Provider (Agent API SDK)
 * objects declare only their top-level fields.
 *
 * Wire note: values are described as the handlers return them. Some carry `bigint` (dashboard and
 * plan holdings) or `undefined` inside arrays (`rebalance`'s `steps`); those survive only through the
 * oRPC RPC serializer, not plain JSON. Each such place is marked "serializer:" below.
 */
import { z } from "zod";
import { ownerCompensationView } from "../compensation-contract.js";
import { RecordingSchema } from "./run-log-schema.js";
// Server modules with filesystem, crypto or AG-UI dependencies stay out of this browser-safe package: their shapes are
// restated here, and test/contract-owner.test.ts proves every handler output is accepted by these schemas.

// ---------------------------------------------------------------------------------------------
// Shared pieces

const record = z.record(z.string(), z.unknown());
/** A provider status (StatusResponse["status"]); kept open: local records also hold "PREPARED", "UNKNOWN", "EXPIRED". */
const status = z.string();

/** SDK OwnerWallet (near | evm | passkey): only the discriminant and key are declared. */
/** SDK OwnerWallet: discriminated by `type`, so a near owner's `account_id` is typed. */
const ownerWallet = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }),
  z.looseObject({ type: z.literal("evm"), address: z.string(), chain_id: z.number(), public_key: z.string() }),
  z.looseObject({ type: z.literal("passkey"), credential_id: z.string(), public_key: z.string(), rp_id: z.string(), origin: z.string() }),
]);
/** dao-owner.ts NearOwner: the DAO's MPC-derived owner account. */
const nearOwner = z.looseObject({ type: z.literal("near"), account_id: z.string(), public_key: z.string() });

/** SDK Policy: top-level fields; nested destinations and limits kept open. */
const policy = z.looseObject({
  frozen: z.boolean(),
  actions: z.array(z.enum(["swap", "transfer", "withdraw"])),
  confidential: z.boolean(),
  owner_approval: z.boolean(),
  assets: z.union([z.literal("any"), z.array(z.string())]),
  limits: z.looseObject({
    per_transaction: z.record(z.string(), z.string()).optional(),
    hourly: z.record(z.string(), z.string()).optional(),
    daily: z.record(z.string(), z.string()).optional(),
    monthly: z.record(z.string(), z.string()).optional(),
  }),
  max_actions_per_hour: z.number().nullable(),
  destinations: z.looseObject({
    mode: z.enum(["any", "only", "except"]),
    // SDK destination entries: a transfer carries `confidential`; a withdrawal its chain and memo.
    list: z.array(z.discriminatedUnion("action", [
      z.looseObject({ action: z.literal("transfer"), address: z.string(), confidential: z.boolean() }),
      z.looseObject({ action: z.literal("withdraw"), chain: z.string(), address: z.string(), memo: z.string().nullable() }),
    ])),
  }),
  budget: z.looseObject({ daily_usd: z.string().nullable(), weekly_usd: z.string().nullable(), monthly_usd: z.string().nullable() }),
  timelock_ms: z.number(),
  // SDK `Schedule`: when the policy allows actions, in the owner's time zone.
  schedule: z.looseObject({
    mode: z.enum(["only", "except"]),
    time_zone: z.string(),
    windows: z.array(z.looseObject({ days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])), start: z.string(), end: z.string() })),
  }).optional(),
  sign: z.looseObject({ recipients: z.array(z.string()) }).optional(),
});
const cooldowns = z.looseObject({ policy_change_available_at: z.string().nullable(), unfreeze_available_at: z.string().nullable() });
const budgetWindow = z.looseObject({ limit_usd: z.string().nullable(), spent_usd: z.string(), remaining_usd: z.string().nullable(), resets_at: z.string().nullable() });
/** SDK PolicyView, as `api.getPolicy` returns it. */
const policyView = z.looseObject({
  wallet_id: z.string(),
  revision: z.number().nullable(),
  // Provider evidence neither Proto nor the apps use: tolerated when absent, so its omission cannot fail every read.
  policy_hash: z.string().nullable().optional(),
  status: z.enum(["NONE", "SIGNED", "APPLIED", "FAILED"]),
  applied_at: z.string().nullable().optional(),
  transaction_hash: z.string().nullable().optional(),
  provider_policy_synced: z.boolean(),
  cooldowns,
  policy: policy.nullable(),
  usage: z.looseObject({
    budget: z.looseObject({ daily: budgetWindow, weekly: budgetWindow, monthly: budgetWindow }),
    timelock: z.looseObject({ delay_ms: z.number(), scheduled_count: z.number() }),
  }),
});
/** SDK GrantView, as `api.listGrants` returns it; `owner_message` is the signed grant message (opaque here). */
const grantView = z.looseObject({
  grant_id: z.string(),
  agent_id: z.string(),
  wallet_id: z.string(),
  label: z.string(),
  issued_at: z.string(),
  expires_at: z.string(),
  revoked_at: z.string().nullable(),
  revoked_reason: z.string().nullable().optional(), // unused provider evidence; tolerated when absent
  owner_epoch: z.number(),
  owner_message: z.unknown(),
});
/** The grant summary several reads project from a GrantView. */
const grantSummary = z.looseObject({ id: z.string(), label: z.string(), expiresAt: z.string() });
/** SDK Intent (nep413 | nep366 | eip712 | webauthn): the payload is what the owner signs, kept opaque. */
/** SDK Intent: each signing standard with its payload, so a signer narrows on `standard` without casting. */
const intent = z.discriminatedUnion("standard", [
  z.looseObject({ standard: z.literal("nep413"), payload: z.looseObject({ message: z.string(), recipient: z.string(), nonce: z.string() }) }),
  z.looseObject({ standard: z.literal("nep366"), payload: z.looseObject({ receiverId: z.string(), actions: z.array(z.looseObject({
    type: z.literal("FunctionCall"), params: z.looseObject({ methodName: z.string(), args: z.record(z.string(), z.unknown()), gas: z.string(), deposit: z.string() }) })) }) }),
  z.looseObject({ standard: z.literal("eip712"), payload: z.looseObject({ domain: z.record(z.string(), z.unknown()),
    types: z.record(z.string(), z.array(z.looseObject({ name: z.string(), type: z.string() }))), primaryType: z.string(), message: z.record(z.string(), z.unknown()) }) }),
  z.looseObject({ standard: z.literal("webauthn"), payload: z.looseObject({ challenge: z.string(), rpId: z.string(),
    allowCredentials: z.array(z.looseObject({ id: z.string(), type: z.literal("public-key") })), userVerification: z.literal("required"), timeout: z.number() }) }),
]);
/** SDK IntentPreview. */
const intentPreview = z.looseObject({
  summary: z.string(),
  revision: z.number().optional(),
  previous_revision: z.number().optional(),
  policy_hash: z.string().optional(),
  policy: policy.optional(),
  deletion: z.unknown().optional(),
  approval: z.looseObject({ approval_id: z.string(), request_type: z.string(), request_hash: z.string(), verdict: z.enum(["approve", "reject"]) }).optional(),
});
/** A NEAR transaction for a wallet to sign: dao-owner.ts signTransaction/proposalTransaction/proposalAndVote, chain.ts fundingTransaction. */
const callArgs = z.custom<object>(value => typeof value === "object" && value !== null && !Array.isArray(value), "Expected call arguments as an object");
const nearTransaction = z.looseObject({
  receiverId: z.string(),
  actions: z.array(z.looseObject({
    type: z.literal("FunctionCall"),
    // Typed `object`, as wallets' signAndSendTransaction expects.
    params: z.looseObject({ methodName: z.string(), args: callArgs, gas: z.string(), deposit: z.string() }),
  })),
});
/** Which held payment an approval vote releases or rejects (owner-intents.ts paymentOf). */
const votedPayment = z.looseObject({ correlationId: z.string(), verdict: z.enum(["approve", "reject"]) }).nullable();
/** ops.ts Op: one journal operation folded with its outcome. Optional fields are absent from older lines. */
const op = z.looseObject({
  at: z.string(),
  idempotencyKey: z.string(),
  kind: z.string(),
  method: z.enum(["swap", "transfer", "shield", "unshield"]).optional(),
  request: record,
  journalVersion: z.literal(2).optional(),
  invoiceId: z.string().optional(),
  submissionState: z.enum(["PREPARED", "SUBMISSION_ATTEMPTED", "OBSERVED", "UNKNOWN", "RESOLVED"]).optional(),
  correlationId: z.string().optional(),
  status: z.string().optional(),
  refused: z.string().optional(),
  policyRevision: z.number().nullable().optional(),
  policyDigest: z.string().nullable().optional(),
  planId: z.string().optional(),
  usdIn: z.number().nullable().optional(),
});
/** planning/model.ts PlannedAction. */
const plannedAction = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("swap"), from: z.string(), to: z.string(), amount: z.string(), amountOut: z.string(), minAmountOut: z.string(), costBps: z.number() }),
  z.looseObject({ type: z.literal("shield"), asset: z.string(), amount: z.string() }),
]);
/** planning/model.ts Plan. */
const plan = z.looseObject({
  id: z.string(),
  source: z.enum(["steward", "rebalance", "external"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  instruction: z.string(),
  actions: z.array(plannedAction),
  agentId: z.string(),
  policyRevision: z.number().nullable(),
  policyDigest: z.string().nullable(),
  strategyDigest: z.string(),
  balances: z.record(z.string(), z.looseObject({ public: z.string(), confidential: z.string() })),
});
/** holdings.ts Holding. serializer: `public` and `confidential` are bigint. */
const holding = z.looseObject({
  asset: z.string(), symbol: z.string(), decimals: z.number(), price: z.number(),
  public: z.bigint(), confidential: z.bigint(), usd: z.number(),
});
/** A loose copy of the strategy: Strategy itself is a stripping z.object. */
const strategy = z.looseObject({ targetBps: z.record(z.string(), z.number()), minLegUsd: z.number(), maxCostBps: z.number(),
  autopilot: z.looseObject({ everyMin: z.number(), maxUsd: z.number() }) });
/** strategy-controls.ts snapshot. */
const strategySnapshot = z.looseObject({ strategy, digest: z.string(), on: z.boolean() });
/** autopilot.ts status. */
const autopilotStatus = z.looseObject({
  on: z.boolean(), everyMin: z.number(), maxUsd: z.number(),
  lastRun: z.string().nullable(), nextRun: z.string().nullable(),
});
/** invoices.ts Status. */
const invoiceStatus = z.enum(["needs_agreement", "refused", "busy", "prepared", "waiting", "paying", "paid", "failed", "unknown", "needs_review"]);
/** invoice-store.ts StoredInvoice. */
const storedInvoice = z.looseObject({
  id: z.string(),
  payee: z.string(),
  submission: z.string(),
  amount: z.string(),
  note: z.string(),
  at: z.string(),
  revision: z.number(),
  operation: op,
  reservation: z.string(),
  review: z.boolean(),
  revisions: z.array(z.looseObject({ revision: z.number(), amount: z.string(), note: z.string(), review: z.number() })),
});

// ---------------------------------------------------------------------------------------------
// Reads

/** rpc/observations.ts setup (with linkedDao). Without an agent, every field but `dao` and `executor` is null. */
export const setupOutput = z.looseObject({
  agentId: z.string().nullable(),
  executor: z.boolean(),
  wallet: z.string().nullable(),
  owner: ownerWallet.nullable(),
  grant: grantSummary.nullable(),
  dao: z.looseObject({ id: z.string(), owner: nearOwner, funded: z.boolean() }).nullable(),
});
/** rpc/observations.ts instance. */
export const instanceOutput = z.looseObject({ agentId: z.string().nullable(), executor: z.boolean() });
/** dashboard-holdings.ts dashboardHoldings `managed` row. serializer: `public` and `confidential` are bigint. */
const managedHolding = z.looseObject({
  asset: z.string(), symbol: z.string(), decimals: z.number(),
  public: z.bigint(), confidential: z.bigint(),
  price: z.number().nullable(), priceUpdatedAt: z.string().nullable(), priceExpiresAt: z.string().nullable(),
  usd: z.number().nullable(),
});
/** dashboard-holdings.ts dashboardHoldings `unmanaged` row. serializer: `amount` is bigint. */
const unmanagedHolding = z.looseObject({
  asset: z.string(), symbol: z.string(), decimals: z.number().nullable(), amount: z.bigint(),
  price: z.number().nullable(), priceUpdatedAt: z.string().nullable(), priceExpiresAt: z.string().nullable(),
  usd: z.number().nullable(),
});
/** rpc/observations.ts overview. `area` is absent unless DASHBOARD_AREA is configured. */
export const overviewOutput = z.looseObject({
  agentId: z.string(),
  area: z.enum(["payables", "treasury"]).optional(),
  book: z.array(managedHolding),
  unmanaged: z.array(unmanagedHolding),
  target: z.record(z.string(), z.number()),
  rebalance: z.looseObject({ minLegUsd: z.number(), maxCostBps: z.number() }),
  policy: policyView,
  digest: z.string().nullable(),
  notInForce: z.string().nullable(),
  agreed: z.array(z.string()),
  grants: z.array(grantView),
});
/** rpc/observations.ts policyHistory. */
export const policyHistoryOutput = z.array(z.looseObject({
  revision: z.number().nullable(),
  status: z.enum(["NONE", "SIGNED", "APPLIED", "FAILED"]),
  appliedAt: z.string().nullable(),
  transactionHash: z.string().nullable(),
  digest: z.string().nullable(),
}));
/** rpc/observations.ts activity (ops.ts readOps projection). Absent fields are omitted, not null. */
export const activityOutput = z.array(z.looseObject({
  at: z.string(),
  kind: z.string(),
  request: record,
  correlationId: z.string().optional(),
  status: z.string().optional(),
  refused: z.string().optional(),
  policyRevision: z.number().nullable().optional(),
  policyDigest: z.string().nullable().optional(),
  planId: z.string().optional(),
}));
/**
 * What the provider answered when a claimed submission failed without a proven outcome (submission-evidence.ts). Diagnostic
 * only: it never resolves, links or clears the operation, and nothing may treat it as an outcome.
 */
export const unresolvedEvidence = z.looseObject({
  at: z.string(),
  httpStatus: z.number(),
  code: z.string(),
  /** The provider's id for the failed request, to quote to the provider. Not an operation or correlation id. */
  requestId: z.string().nullable(),
  /** Ids the provider's error happened to include. Unverified: never a correlation for `paymentStatus` or recovery. */
  providerIds: z.record(z.string(), z.string()),
  message: z.string(),
  /** States that the evidence establishes no correlation, execution or permission to clear the operation. */
  note: z.string(),
});
/**
 * rpc/observations.ts unresolved. The operation fields are authoritative and strict. `evidence` is absent from servers
 * before Recovery B, null without a recorded answer, and null when malformed: a bad diagnostic never hides the operation.
 */
export const unresolvedOutput = z.array(z.looseObject({
  key: z.string(), at: z.string(), kind: z.string(), request: record, status: z.string().nullable(), sent: z.boolean(),
  evidence: unresolvedEvidence.nullable().optional().catch(null),
}));
/** payouts.ts held: local held operations, and the API's (kind "remote") not recorded here. */
export const heldOutput = z.array(z.looseObject({
  at: z.string(), kind: z.string(), request: record, correlationId: z.string(), approvalId: z.string(),
}));
/** inbox.ts readInbox Entry. */
export const inboxListOutput = z.array(z.looseObject({
  id: z.string(), at: z.string(), level: z.enum(["run", "warn", "action"]), text: z.string(), dismissed: z.boolean().optional(),
}));
/** autopilot.ts status. */
export const autopilotGetOutput = autopilotStatus;

/** evidence.ts Observation | { error } (Seen). */
const seen = z.union([
  z.looseObject({
    at: z.string(),
    book: z.array(z.looseObject({ asset: z.string(), public: z.string(), confidential: z.string(), usd: z.number() })),
    weightsBps: z.record(z.string(), z.number()),
    targetBps: z.record(z.string(), z.number()),
    driftBps: z.number(),
    budget: z.unknown(),
    unresolved: z.number(),
  }),
  z.looseObject({ error: z.string() }),
]);
/**
 * evidence.ts ticks: `Tick` as read back. Lines are JSON.parse'd without validation, so historical
 * records may differ from the current TickStart/TickEnd types.
 */
export const autopilotEvidenceOutput = z.looseObject({
  ticks: z.array(z.looseObject({
    progressVersion: z.literal(1).optional(),
    id: z.string(),
    at: z.string(),
    trigger: z.enum(["schedule", "operator"]),
    schedule: z.looseObject({ on: z.boolean(), everyMin: z.number(), maxUsd: z.number(), lastRun: z.string().nullable() }),
    build: z.looseObject({ deployment: z.string().nullable(), source: z.string(), lockfile: z.string().nullable(), packageJson: z.string().nullable() }),
    agentId: z.string(),
    policy: z.looseObject({ revision: z.number().nullable(), digest: z.string().nullable(), status: z.string() }),
    strategy: z.string(),
    grant: grantSummary.nullable(),
    end: z.looseObject({
      progressIncomplete: z.boolean().optional(),
      endedAt: z.string(),
      before: seen,
      after: seen,
      plan: z.looseObject({
        id: z.string(), usd: z.number(),
        legs: z.array(z.looseObject({ from: z.string(), to: z.string(), amount: z.string(), amountOut: z.string(), minAmountOut: z.string(), costBps: z.number() })),
      }).nullable(),
      steps: z.array(z.looseObject({ index: z.number(), status: z.string(), correlationId: z.string(), failureCode: z.string().nullable() })),
      shields: z.array(z.looseObject({ asset: z.string(), status: z.string(), correlationId: z.string() })),
      rejected: z.array(z.string()),
      refusal: z.string().nullable(),
      outcome: z.string(),
    }).nullable(),
  })),
  corrupt: z.array(z.number()),
});
/** run-log-export.ts exportRunLog → agui.ts tickLog: the strict recording format, which the handler already parses its output with. */
export const autopilotLogOutput = RecordingSchema;
/** strategy-status.ts readStrategyStatus. */
export const strategyGetOutput = z.looseObject({
  strategy,
  digest: z.string(),
  grantSuffix: z.string(),
  executor: z.boolean(),
  on: z.boolean(),
  /** null on an approve-only host. */
  grantMatches: z.boolean().nullable(),
  unresolved: z.number(),
  grant: grantSummary.nullable(),
  readiness: z.looseObject({
    state: z.enum(["approve-only", "blocked", "authorization-required", "ready", "off"]),
    reasons: z.array(z.string()),
    canEnable: z.boolean(),
  }),
  observedAt: z.string(),
});
/** rpc/treasury.ts treasury.get (chain.ts describeTreasury + daoPayees); null when no treasury is linked. */
export const treasuryGetOutput = z.looseObject({
  accountId: z.string(),
  /** chain.ts council, or null when the account is not a DAO. */
  dao: z.looseObject({
    members: z.array(z.string()),
    approvers: z.array(z.looseObject({ role: z.string(), threshold: z.string() })),
  }).nullable(),
  balances: z.looseObject({ near: z.string(), usdc: z.string() }),
  confidential: z.boolean(),
  payees: z.array(z.looseObject({ address: z.string(), proposalId: z.number(), description: z.string() })),
}).nullable();
/** ledger.ts ledger Row. */
const ledgerRow = z.looseObject({
  at: z.string(),
  settledAt: z.string(),
  type: z.string(),
  status: z.string(),
  failureCode: z.string().nullable(),
  confidential: z.boolean(),
  assetIn: z.string().nullable(),
  amountIn: z.string().nullable(),
  assetOut: z.string().nullable(),
  amountOut: z.string().nullable(),
  recipient: z.string().nullable(),
  correlationId: z.string(),
  intentHash: z.string().nullable(),
  approvalId: z.string().nullable(),
  kind: z.string().nullable(),
  planId: z.string().nullable(),
  policyRevision: z.number().nullable(),
  policyDigest: z.string().nullable(),
  usdIn: z.number().nullable(),
});
/** ledger.ts ledger. */
export const ledgerOutput = z.array(ledgerRow);
/** ledger.ts ledgerCsv: the CSV text. */
export const ledgerCsvOutput = z.string();
/** ledger.ts reconcileBooks Reconciliation. Amounts are raw-unit decimal strings. */
export const reconcileBooksOutput = z.array(z.looseObject({
  asset: z.string(),
  symbol: z.string(),
  public: z.looseObject({ api: z.string(), chain: z.string(), drift: z.string() }),
  confidential: z.looseObject({ api: z.string(), recorded: z.string(), unattributed: z.string() }),
}));
/** payouts.ts paymentHistory. */
export const paymentHistoryOutput = z.looseObject({
  items: z.array(z.looseObject({ correlationId: z.string(), at: z.string() })),
  complete: z.boolean(),
});
/** payouts.ts paymentStatus (evidence: provider-display.ts paymentEvidence). */
export const paymentStatusOutput = z.looseObject({
  status,
  failureCode: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  request: record.nullable(),
  approvalId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  detailError: z.string().nullable(),
  evidence: z.looseObject({
    txHash: z.string().nullable(),
    destinationTxHash: z.string().nullable(),
    refundTxHash: z.string().nullable(),
    refundTo: z.string().nullable(),
    refundedAmount: z.string().nullable(),
  }),
});
/** invoice-store.ts listInvoices. */
export const invoicesOutput = z.array(storedInvoice);
/** agreements.ts Agreement, from localStore.list or remoteStore.list (the latter already parsed by agreementList). */
const agreement = z.looseObject({
  id: z.string(),
  at: z.string(),
  origin: z.enum(["payee", "owner"]),
  payee: z.string(),
  amount: z.string(),
  note: z.string(),
  submission: z.string().optional(),
  terms: z.looseObject({ maxAmount: z.string(), until: z.string() }).optional(),
  status: z.enum(["requested", "proposed", "agreed", "filed", "declined"]),
});
/** agreements.ts AgreementStore.list. */
export const agreementsListOutput = z.array(agreement);
/** owner-intents.ts status (the `outcomes` map's entries included). */
export const ownerStatusOutput = z.looseObject({
  stage: z.enum(["submitted", "submitting", "expired", "failed", "voting", "unknown"]),
  status: status.optional(),
  failureCode: z.string().nullable().optional(),
  error: z.string().optional(),
  /** Only for `voting`. */
  expiresAt: z.string().optional(),
});
/** owner-intents.ts daoRequests: kept requests and the archived expired ones (`.expired.jsonl`, unvalidated JSON). */
export const ownerPendingOutput = z.array(z.looseObject({
  correlationId: z.string(),
  type: z.string(),
  expiresAt: z.string(),
  hash: z.string(),
  intent,
  delegate: z.string().nullable(),
  /** "done" | "waiting" | "expired" at runtime; the handler's type widens it to string, so it is declared as one. */
  state: z.string(),
  payment: votedPayment,
}));
/** owner-intents.ts ownerActions. */
export const ownerActionsOutput = z.array(z.looseObject({
  correlationId: z.string(),
  type: z.string(),
  expiresAt: z.string(),
  signer: z.enum(["dao", "wallet"]),
  stage: z.enum(["settled", "submitted", "expired", "prepared"]),
  ownerSucceeded: z.boolean(),
  status: z.string().nullable(),
  failureCode: z.string().nullable(),
  payment: votedPayment,
}));
/** compensation.ts ownerCompensation (CompensationOwnerView); reused from compensation-contract.ts, top level kept loose. */
const compensationOwnerView = ownerCompensationView.loose();
export const compensationListOutput = compensationOwnerView;
/** work-order-store.ts WorkOrder (strict record schema, reused; top level kept loose). */
const workOrder = z.looseObject({ id: z.string(), payee: z.string(), amount: z.string(), note: z.string(), until: z.string(), asset: z.string(),
  owner: z.looseObject({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }), dao: z.string().optional(),
  version: z.literal(1), parentAgentId: z.string(), createdAt: z.string() });
/** work-orders.ts workOrders.list → work-order-store.ts listWorkOrders. Remote results are not re-parsed. */
export const workOrdersListOutput = z.array(workOrder);
/** invoices.ts mine: the payee read model a work order snapshot carries. */
const payeeInvoice = z.looseObject({
  id: z.string(),
  amount: z.string().nullable(),
  note: z.string(),
  filedAt: z.string(),
  status: invoiceStatus,
  revisionConflict: z.boolean(),
});
/** work-order-protocol.ts WorkOrderSnapshot (WorkOrderReply["snapshot"]). */
export const workOrdersGetOutput = z.looseObject({
  order: workOrder,
  agentId: z.string().nullable(),
  wallet: z.string().nullable(),
  balance: z.string().nullable(),
  policyReady: z.boolean(),
  grant: z.looseObject({ id: z.string(), expiresAt: z.string() }).nullable(),
  invoice: payeeInvoice.nullable(),
  ownerActions: ownerActionsOutput,
  approval: z.looseObject({ correlationId: z.string(), approvalId: z.string() }).nullable(),
  error: z.string().nullable(),
  /**
   * Server-computed readiness (work-order-protocol.ts workOrderProgress): apps read it instead of copying the rules.
   * `unavailable` when observations failed or the balance is unknown; it never fails the read.
   */
  progress: z.looseObject({ stage: z.string(), expired: z.boolean(), residual: z.string().nullable(), excess: z.string().nullable() }),
});
/** work-order-protocol.ts WorkOrderReply["status"] = owner-intents.ts status. */
export const workOrdersStatusOutput = ownerStatusOutput;

// ---------------------------------------------------------------------------------------------
// Mutations

/** agent.ts pay: settled by the provider, or a proven refusal (details: provider-display.ts refusalDetails). */
export const payOutput = z.discriminatedUnion("outcome", [
  z.looseObject({ outcome: z.literal("settled"), status, correlationId: z.string(), failureCode: z.string().nullable() }),
  z.looseObject({
    outcome: z.literal("refused"),
    code: z.string(),
    details: z.looseObject({ availableAt: z.string().optional(), budgetRemainingUsd: z.string().optional() }).optional(),
  }),
]);
/** agent.ts depositAddress. */
export const depositOutput = z.looseObject({
  correlationId: z.string(),
  address: z.string(),
  memo: z.string().nullable(),
  minAmount: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
/** rpc/observations.ts recover (recover.ts recover projection). */
export const recoverOutput = z.array(z.looseObject({
  key: z.string(),
  outcome: z.enum(["settled", "refused", "open", "unknown"]),
  status: z.string().nullable(),
  detail: z.string().nullable(),
}));
/** invoice-store.ts cancelPreparedInvoice: the invoice after cancellation. */
export const cancelPreparedInvoiceOutput = storedInvoice;
/** inbox.ts dismiss: returns nothing. */
export const inboxDismissOutput = z.void();
/** owner-intents.ts prepare: a wallet's intent and signer, or (signer "dao") the transactions DAO members file. */
export const ownerPrepareOutput = z.looseObject({
  correlationId: z.string(),
  preview: intentPreview,
  expiresAt: z.string(),
  /** mandate.ts mandateDigest of a policy_update's requested policy; null otherwise. */
  digest: z.string().nullable(),
  /** Wallet signer only. */
  intent: intent.optional(),
  /** Wallet signer only. */
  signer: ownerWallet.optional(),
  /** DAO signer only. */
  dao: z.looseObject({
    owner: z.string(),
    transaction: nearTransaction,
    proposal: nearTransaction.nullable(),
    proposalAndVote: nearTransaction.nullable(),
  }).optional(),
});
/** owner-intents.ts submit: the recorded or reconciled owner outcome. */
export const ownerSubmitOutput = z.looseObject({ status, failureCode: z.string().nullable().optional() });
/** agreements.ts AgreementStore.propose: returns nothing. */
export const agreementsProposeOutput = z.void();
/** rpc/payables.ts agreements.offer. */
export const agreementsOfferOutput = z.looseObject({ id: z.string() });
/** agreements.ts AgreementStore.decline: returns nothing. */
export const agreementsDeclineOutput = z.void();
/** compensation.ts ownerCompensation. */
export const compensationAgreementOutput = compensationOwnerView;
/** compensation.ts ownerCompensation. */
export const compensationReviewOutput = compensationOwnerView;
/** compensation.ts ownerCompensation. */
export const compensationPrepareOutput = compensationOwnerView;
/** compensation.ts ownerCompensation. */
export const compensationSendOutput = compensationOwnerView;
/** work-order-store.ts createWorkOrder. */
export const workOrdersCreateOutput = workOrder;
/** work-order-protocol.ts WorkOrderReply["prepare"] = owner-intents.ts prepare. */
export const workOrdersPrepareOutput = ownerPrepareOutput;
/** work-order-protocol.ts WorkOrderReply["submit"] = owner-intents.ts submit. */
export const workOrdersSubmitOutput = ownerSubmitOutput;
/** work-order-protocol.ts WorkOrderReply["deposit"] = agent.ts depositAddress. */
export const workOrdersDepositOutput = depositOutput;
/** invoices.ts file (Filing). */
export const workOrdersFileOutput = z.looseObject({ id: z.string(), status: invoiceStatus, revisionConflict: z.boolean().optional() });
/** strategy-controls.ts saveReviewedStrategy (snapshot). */
export const strategySaveOutput = strategySnapshot;
/** rpc/treasury.ts autopilot.set: autopilot.ts status after setLegacySchedule. */
export const autopilotSetOutput = autopilotStatus;
/** strategy-controls.ts enableSchedule (snapshot). */
export const autopilotEnableOutput = strategySnapshot;
/** strategy-controls.ts stopSchedule. */
export const autopilotStopOutput = z.looseObject({ on: z.literal(false) });
/** autopilot.ts tick: the tick's summary (as the inbox shows it). */
export const autopilotTickOutput = z.string();
/** rpc/treasury.ts treasury.link: returns nothing. */
export const treasuryLinkOutput = z.void();
/** rpc/treasury.ts treasury.unlink: returns nothing. */
export const treasuryUnlinkOutput = z.void();
/** rpc/treasury.ts treasury.setConfidential (env.ts saveEnv): returns nothing. */
export const treasurySetConfidentialOutput = z.void();
/** rpc/treasury.ts treasury.fund: a deposit address and chain.ts fundingTransaction. */
export const treasuryFundOutput = z.looseObject({ deposit: depositOutput, transaction: nearTransaction });
/** planning/external.ts prepareExternalPlan. */
export const externalPlanOutput = plan;

// ---------------------------------------------------------------------------------------------
// Streams: one yielded event each. Every generator below returns nothing (void) when done.

/** treasury.ts rebalance RebalanceEvent. serializer: holdings and leg amounts are bigint; `steps` may hold undefined. */
export const rebalanceEvent = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("plan"),
    total: z.number(),
    book: z.array(holding),
    legs: z.array(z.looseObject({ from: holding, to: holding, usd: z.number(), amount: z.bigint() })),
    /** treasury.ts budgetRemaining. */
    budget: z.string().nullable().optional(),
    strategy,
  }),
  z.looseObject({
    type: z.literal("quote"),
    leg: z.number(),
    skipped: z.boolean(),
    amountOut: z.string(),
    minAmountOut: z.string(),
    costBps: z.number(),
    worstCostBps: z.number(),
  }),
  /** `steps[i]` is leg i's step in the plan, undefined when the leg was skipped. */
  z.looseObject({ type: z.literal("saved"), plan, steps: z.array(z.number().optional()) }),
]);
/** planning/execution.ts executePlan PlanEvent. */
export const executePlanEvent = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("rejected"), problems: z.array(z.string()) }),
  z.looseObject({
    type: z.literal("action"),
    index: z.number(),
    action: plannedAction,
    shield: z.looseObject({ amount: z.string(), status: z.string() }).optional(),
    /** `NOT_SENT` when the shield before it did not succeed. */
    status,
    correlationId: z.string(),
    failureCode: z.string().nullable().optional(),
  }),
]);
/** treasury.ts sweep SweepEvent. serializer: `exposed` holdings carry bigint. */
export const sweepEvent = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("plan"), exposed: z.array(holding) }),
  z.looseObject({ type: z.literal("shield"), asset: z.string(), status, correlationId: z.string(), failureCode: z.string().nullable().optional() }),
]);
/** llm.ts steward StewardEvent. */
export const stewardProposeEvent = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("say"), text: z.string() }),
  z.looseObject({ type: z.literal("call"), name: z.string(), input: z.unknown() }),
  z.looseObject({ type: z.literal("result"), name: z.string(), result: z.string() }),
  z.looseObject({ type: z.literal("verified"), completionId: z.string(), signatureKind: z.string() }),
  z.looseObject({ type: z.literal("plan"), plan }),
]);

export const ownerOutputs = {
  "setup": setupOutput,
  "instance": instanceOutput,
  "overview": overviewOutput,
  "policyHistory": policyHistoryOutput,
  "activity": activityOutput,
  "unresolved": unresolvedOutput,
  "held": heldOutput,
  "inbox/list": inboxListOutput,
  "autopilot/get": autopilotGetOutput,
  "autopilot/evidence": autopilotEvidenceOutput,
  "autopilot/log": autopilotLogOutput,
  "strategy/get": strategyGetOutput,
  "treasury/get": treasuryGetOutput,
  "ledger": ledgerOutput,
  "ledgerCsv": ledgerCsvOutput,
  "reconcileBooks": reconcileBooksOutput,
  "paymentHistory": paymentHistoryOutput,
  "paymentStatus": paymentStatusOutput,
  "invoices": invoicesOutput,
  "agreements/list": agreementsListOutput,
  "owner/status": ownerStatusOutput,
  "owner/pending": ownerPendingOutput,
  "owner/actions": ownerActionsOutput,
  "compensation/list": compensationListOutput,
  "workOrders/list": workOrdersListOutput,
  "workOrders/get": workOrdersGetOutput,
  "workOrders/status": workOrdersStatusOutput,
  "pay": payOutput,
  "deposit": depositOutput,
  "recover": recoverOutput,
  "cancelPreparedInvoice": cancelPreparedInvoiceOutput,
  "inbox/dismiss": inboxDismissOutput,
  "owner/prepare": ownerPrepareOutput,
  "owner/submit": ownerSubmitOutput,
  "agreements/propose": agreementsProposeOutput,
  "agreements/offer": agreementsOfferOutput,
  "agreements/decline": agreementsDeclineOutput,
  "compensation/agreement": compensationAgreementOutput,
  "compensation/review": compensationReviewOutput,
  "compensation/prepare": compensationPrepareOutput,
  "compensation/send": compensationSendOutput,
  "workOrders/create": workOrdersCreateOutput,
  "workOrders/prepare": workOrdersPrepareOutput,
  "workOrders/submit": workOrdersSubmitOutput,
  "workOrders/deposit": workOrdersDepositOutput,
  "workOrders/file": workOrdersFileOutput,
  "strategy/save": strategySaveOutput,
  "autopilot/set": autopilotSetOutput,
  "autopilot/enable": autopilotEnableOutput,
  "autopilot/stop": autopilotStopOutput,
  "autopilot/tick": autopilotTickOutput,
  "treasury/link": treasuryLinkOutput,
  "treasury/unlink": treasuryUnlinkOutput,
  "treasury/setConfidential": treasurySetConfidentialOutput,
  "treasury/fund": treasuryFundOutput,
  "externalPlan": externalPlanOutput,
  "rebalance": rebalanceEvent,
  "executePlan": executePlanEvent,
  "sweep": sweepEvent,
  "steward/propose": stewardProposeEvent,
} as const;

/** Procedures whose output is an event stream: `ownerOutputs` holds the schema of one yielded event. */
export const ownerStreams = ["rebalance", "executePlan", "sweep", "steward/propose"] as const;
