import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { agentId } from "./env.js";
import { OPERATION_METHODS } from "./contract/owner-outputs.js";
import { hireTerms, marketBrief, payoutRequestId } from "./contract/inputs.js";
import { appendSynced, mkdirSynced } from "./synced.js";
import { claimInvoiceSubmission, invoiceOperations, recordInvoiceOperation, type PaymentState } from "./invoice-store.js";
import { isTerminal } from "./operation-status.js";
import { requestKey } from "./request-key.js";
import { briefDigest, OPEN_ACCOUNT_WNEAR, PaymentRow, sameTerms, termsOf, type X402Request } from "./market/x402.js";
import { ASSETS } from "./policy.js";
import type { HireTerms } from "./market/x402.js";
import { allocationIdentity, parseAllocation, signedAllocationSchema, type SignedAllocation } from "./market/allocation-types.js";

export { isTerminal };

const nonempty = z.string().min(1);

/**
 * The append-only log of one agent's money actions, `.ops/<agent id>.jsonl`. A request line is
 * written before anything is sent; later lines for the same key record what came back. An
 * operation is unresolved until a line proves its outcome, and unresolved operations block that
 * agent's new money actions (see lock.ts). Agents share no balances, so they share no log.
 */
export function opsLog() {
  const id = agentId();
  mkdirSynced(".ops");
  return join(".ops", `${id}.jsonl`);
}

export type Method = (typeof OPERATION_METHODS)[number];

/** What a request line records beside the request: the mandate it ran under and what it was worth. */
type Context = {
  policyRevision?: number | null;
  /** `mandateDigest` of the policy in force when the request was sent. */
  policyDigest?: string | null;
  /** Cancellation is allowed after policy removal; retain the original order's signed mandate separately. */
  originalOrderPolicyDigest?: string | null;
  /** The plan this action executes, when it executes one. */
  planId?: string;
  /** The input's value at a fresh API token price when authorized; null when unavailable. */
  usdIn?: number | null;
};

export type Line =
  | ({ at: string; idempotencyKey: string; kind: string; method?: Method; request: Record<string, unknown>; journalVersion?: 2 } & Context)
  /** Outcome lines are stamped when written (`at`), so the log shows how long each took to resolve. */
  | { at?: string; idempotencyKey: string; correlation_id: string; status: string }
  | { at?: string; idempotencyKey: string; refused: string }
  | { at?: string; idempotencyKey: string; submissionState: "SUBMISSION_ATTEMPTED" }
  /** Cancellation accepts no operation correlation id; only a final payout read completes it. */
  | { at?: string; idempotencyKey: string; cancelFinal: true };

export type Op = Context & {
  /** Only v2 records prove that every send was preceded by a durable claim. */
  journalVersion?: 2;
  invoiceId?: string;
  submissionState?: PaymentState;
  at: string;
  idempotencyKey: string;
  kind: string;
  /** Absent on lines written before the method was recorded; inferred from the request instead. */
  method?: Method;
  request: Record<string, unknown>;
  correlationId?: string;
  status?: string;
  refused?: string;
  /** A live order read proved cancellation's payout final, after a claimed submission. */
  cancelFinal?: true;
};

/** A market hire is bound before funding. These records are not money operations. */
export type MarketStage = "open" | "usdc";
export type MarketLanding = { correlationId: string; destinationTxHash: string; finalHeight: string };
export type MarketBinding = {
  at: string;
  idempotencyKey: string;
  actor: string;
  requestId: string;
  brief: string;
  approved: HireTerms;
  paymentAccount: string;
  publicKey: string;
  landed: Partial<Record<MarketStage, MarketLanding>>;
  /** A controlled funding observation can never authorize an x402 payment. */
  fundingOnly?: true;
  /** Owner-signed authority; the source stays fundingOnly and the target names the same evidence. */
  allocation?: SignedAllocation;
  fundingSource?: SignedAllocation;
  /** Terminal refusal written with the final USDC landing when delivered funds cannot cover the hire. */
  refused?: "funding_shortfall";
};

const boundX402Request = z.object({
  handle: nonempty, brief: marketBrief, messageId: nonempty, row: PaymentRow,
  asset: nonempty, amount: z.string().regex(/^[1-9][0-9]*$/),
  payer: nonempty, publicKey: nonempty, nonce: z.string().regex(/^[1-9][0-9]*$/),
  maxBlockHeight: z.string().regex(/^[1-9][0-9]*$/), balanceAtSigning: z.string().regex(/^[0-9]+$/),
});

function matchesBoundPayment(binding: MarketBinding, line: { kind: string; method?: Method; journalVersion?: 2;
  request: Record<string, unknown> }): boolean {
  if (binding.fundingOnly || line.kind !== "market-hire" || line.method !== "x402" || line.journalVersion !== 2) return false;
  const request = boundX402Request.safeParse(line.request);
  if (!request.success || request.data.brief !== binding.brief || request.data.payer !== binding.paymentAccount ||
      request.data.publicKey !== binding.publicKey || request.data.row.scheme !== "exact" ||
      request.data.asset !== `nep141:${request.data.row.asset}` || request.data.amount !== request.data.row.amount) return false;
  return sameTerms(binding.approved, termsOf(request.data as X402Request));
}

function matchesBoundStage(binding: MarketBinding, stage: MarketStage, line: { kind: string; method?: Method;
  journalVersion?: 2; request: Record<string, unknown> }): boolean {
  const asset = stage === "open" ? ASSETS.wNEAR : ASSETS.USDC;
  const allocation = binding.fundingSource && parseAllocation(binding.fundingSource);
  return !binding.refused && line.journalVersion === 2 && line.kind === "market-topup" && line.method === "withdraw" &&
    line.request.asset === asset && line.request.chain === "near" && line.request.recipient === binding.paymentAccount &&
    line.request.confidential === true && line.request.memo === undefined &&
    typeof line.request.amount === "string" && /^[1-9][0-9]*$/.test(line.request.amount) &&
    (stage !== "open" || line.request.amount === OPEN_ACCOUNT_WNEAR) &&
    (stage !== "usdc" || BigInt(line.request.amount) <= BigInt(binding.approved.amount)) &&
    (!allocation || stage === "usdc" && BigInt(line.request.amount) <= BigInt(allocation.maxTopUpUsdc));
}

/** Fixed identities ensure a retry follows a recorded funding stage instead of submitting a new withdrawal. */
export const marketStageKey = (bindingKey: string, stage: MarketStage) => `${bindingKey}:market-${stage}`;

/** Outcome proven: settled terminally, or refused before anything was sent. */
export const isResolved = (op: Op) => op.method === "limit_order_cancel"
  ? op.cancelFinal === true || (op.refused !== undefined && op.submissionState !== "SUBMISSION_ATTEMPTED")
  : op.refused !== undefined || (op.status !== undefined && isTerminal(op.status));

/**
 * Sent, and waiting for the owner's approval. Its outcome is unknown but cannot be lost: the
 * correlation id is logged and the approval releases that one execution, so it never blocks new
 * money actions. The approval, or `pnpm reconcile`, records how it ends.
 */
export const isHeld = (op: Op) => op.status === "PENDING_APPROVAL";

/**
 * An operation whose outcome is unknown, so nothing new may be sent until it's reconciled. Not one
 * held for the owner's approval (`isHeld`), and not an invoice prepared but never submitted: that is
 * a business record with nothing in flight, and its own send is guarded by its submission claim.
 */
export const blocksDispatch = (op: Op) => !isResolved(op) && !isHeld(op) && !(op.invoiceId && op.submissionState === "PREPARED");

/** Individual values of submitted swaps in one plan, from folded journal evidence. Failed or refunded
 * submissions do not replenish its ceiling. Unknown legacy submissions count conservatively;
 * missing valuations remain unknown, and unresolved operations still block dispatch independently. */
export function submittedSwapValues(ops: readonly Op[], planId: string): readonly (number | null)[] {
  return ops.filter(op => op.planId === planId && op.refused === undefined &&
    (op.method === "swap" || (op.method === undefined && "origin_asset" in op.request)) &&
    !(op.journalVersion === 2 && op.submissionState === "PREPARED"))
    .map(op => op.usdIn ?? null);
}

export function record(line: Line) {
  if ("request" in line && line.method === "limit_order_cancel" && line.journalVersion !== 2)
    throw new Error("A limit-order cancellation needs a versioned submission claim");
  if ("request" in line) {
    const bindings = readMarketBindings();
    const boundPayment = bindings.find(binding => binding.idempotencyKey === line.idempotencyKey);
    if (boundPayment && !matchesBoundPayment(boundPayment, line))
      throw new Error("Market payment differs from its binding");
    const stage = /^(.*):market-(open|usdc)$/.exec(line.idempotencyKey);
    if (stage) {
      const binding = bindings.find(binding => binding.idempotencyKey === stage[1]);
      if (!binding || !matchesBoundStage(binding, stage[2] as MarketStage, line))
        throw new Error("Market funding stage differs from its binding");
    }
    const binding = boundPayment ?? (stage && bindings.find(binding => binding.idempotencyKey === stage[1]));
    if (binding?.refused) throw new Error("Market binding is refused; no further operation may be prepared");
  }
  if ("request" in line && line.journalVersion === 2 && readOps().some((op) => op.idempotencyKey === line.idempotencyKey))
    throw new Error("Operation identity already recorded");
  if ("submissionState" in line) {
    const op = readOps().find((op) => op.idempotencyKey === line.idempotencyKey);
    if (!op || op.invoiceId || op.journalVersion !== 2 || op.submissionState !== "PREPARED" || op.correlationId || isResolved(op))
      throw new Error("Operation cannot be claimed; replay is blocked");
  }
  if ("correlation_id" in line) {
    const existing = readOps().find((op) => op.idempotencyKey === line.idempotencyKey);
    if (existing?.method === "limit_order_cancel") throw new Error("A cancellation provider acceptance is not a final payout");
    if (existing?.correlationId && existing.correlationId !== line.correlation_id) {
      throw new Error("Provider operation identity changed");
    }
    if (existing && isResolved(existing) && line.status !== existing.status) {
      return; // never reopen a proven terminal outcome with contradictory evidence
    }
  }
  if ("refused" in line) {
    const existing = readOps().find((op) => op.idempotencyKey === line.idempotencyKey);
    if (existing?.method === "limit_order_cancel" && existing.submissionState === "SUBMISSION_ATTEMPTED")
      throw new Error("A claimed cancellation stays unresolved until its payout is final");
  }
  if ("cancelFinal" in line) {
    const existing = readOps().find((op) => op.idempotencyKey === line.idempotencyKey);
    if (!existing || existing.method !== "limit_order_cancel" || existing.journalVersion !== 2
      || existing.submissionState !== "SUBMISSION_ATTEMPTED" || existing.refused || existing.correlationId || existing.status || existing.cancelFinal)
      throw new Error("Invalid cancel completion: a claimed cancellation may be completed only once after final payout evidence");
  }
  if (recordInvoiceOperation(line)) return;
  appendSynced(opsLog(), { at: new Date().toISOString(), ...line });
}

/** Records a logged operation's latest status, found by its correlation id. */
export function settle(correlationId: string, status: string) {
  const op = readOps().find((o) => o.correlationId === correlationId);
  if (op) record({ idempotencyKey: op.idempotencyKey, correlation_id: correlationId, status });
}

const identity = { idempotencyKey: nonempty, at: z.string().optional() };
// Unknown metadata is ignored. Known lifecycle fields cannot be silently discarded
// by matching a different record shape.
const noOutcome = { correlation_id: z.never().optional(), status: z.never().optional(), refused: z.never().optional(),
  submissionState: z.never().optional(), cancelFinal: z.never().optional() };
const preparationLine = z.object({ ...identity, ...noOutcome, at: z.string(), kind: nonempty, request: z.record(z.string(), z.unknown()),
    authorization: z.never().optional(),
    // `withdraw` since P3b, `x402` (a market hire's payment, docs/market.md) since 0.5.6: a build before either can't read
    // a journal holding one (docs/operations.md, rollback).
    method: z.enum(OPERATION_METHODS).optional(), journalVersion: z.literal(2).optional(),
    policyRevision: z.number().nullable().optional(), policyDigest: z.string().nullable().optional(),
    originalOrderPolicyDigest: z.string().nullable().optional(),
    usdIn: z.number().nullable().optional(), planId: z.string().optional() });
const outcome = { ...identity, ...noOutcome, request: z.never().optional(), journalVersion: z.never().optional(), authorization: z.never().optional() };
// Pre-binding readers, including released 0.5.8 limit-order builds, accept only journalVersion 2 and refuse a market binding.
// The new reader keeps this intent separate from Op[], so it cannot be retired as a never-submitted money action.
const marketBindingLine = z.strictObject({
  at: nonempty, idempotencyKey: nonempty, kind: z.literal("market-binding"), journalVersion: z.literal(3),
  binding: z.strictObject({ actor: nonempty, requestId: payoutRequestId, brief: marketBrief, approved: hireTerms,
    paymentAccount: nonempty, publicKey: nonempty, fundingOnly: z.literal(true).optional() }),
}).superRefine((line, context) => {
  if (line.idempotencyKey !== requestKey(line.binding.actor, line.binding.requestId))
    context.addIssue({ code: "custom", message: "binding identity does not match its caller and request ID" });
  if (briefDigest(line.binding.brief) !== line.binding.approved.brief)
    context.addIssue({ code: "custom", message: "binding brief does not match its approved digest" });
});
const marketLandingLine = z.strictObject({
  at: nonempty, idempotencyKey: nonempty, kind: z.literal("market-landing"), journalVersion: z.literal(3),
  marketLanding: z.strictObject({ stage: z.enum(["open", "usdc"]), correlationId: nonempty,
    destinationTxHash: nonempty, finalHeight: z.string().regex(/^[1-9][0-9]*$/),
    bindingRefusal: z.literal("funding_shortfall").optional() }),
}).superRefine((line, context) => {
  if (line.marketLanding.bindingRefusal && line.marketLanding.stage !== "usdc")
    context.addIssue({ code: "custom", message: "only a USDC landing may refuse a binding" });
});
const journalLine = z.union([
  z.strictObject({ at: nonempty, idempotencyKey: nonempty, kind: z.literal("market-allocation"), journalVersion: z.literal(4), allocation: signedAllocationSchema }),
  marketBindingLine,
  marketLandingLine,
  preparationLine,
  // Legacy snapshots could combine the request and its observed provider identity.
  preparationLine.extend({ journalVersion: z.never().optional(), correlation_id: nonempty, status: nonempty.optional() }),
  z.object({ ...outcome, submissionState: z.literal("SUBMISSION_ATTEMPTED") }),
  z.object({ ...outcome, refused: nonempty }),
  // New in limit orders: the live order view, not cancellation acceptance, proves payout completion.
  z.object({ ...outcome, cancelFinal: z.literal(true) }),
  // Older logs may have a correlation ID without a status: still unresolved, never inferred terminal.
  z.object({ ...outcome, correlation_id: nonempty, status: nonempty.optional() }),
  // Historical authorization snapshots are metadata, never submission or settlement evidence.
  z.object({ ...outcome, at: z.string(), authorization: z.object({ version: z.literal(1) }).passthrough() }).strict(),
]);

/** Every operation in the log, oldest first, folded with the outcomes recorded for it. */
/**
 * Raw amounts that sends held for the owner's vote would take from each asset, if approved: a swap's input, a transfer's
 * or withdrawal's amount. The reported balance still includes them.
 */
export const heldOutgoing = (ops: readonly Op[] = readOps()) => outgoing(ops.filter(isHeld));
const outgoing = (ops: readonly Op[]) => {
  const out: Record<string, bigint> = {};
  for (const op of ops) {
    const asset = String(op.method === "swap" ? op.request.origin_asset : op.request.asset);
    out[asset] = (out[asset] ?? 0n) + BigInt(String(op.request.amount));
  }
  return out;
};

function readJournal(): { ops: Map<string, Op>; bindings: Map<string, MarketBinding> } {
  const log = opsLog();
  const ops = new Map<string, Op>();
  const bindings = new Map<string, MarketBinding>();
  const correlations = new Map<string, string>();
  const landedTransactions = new Set<string>();
  const allocationNonces = new Set<string>();
  for (const [index, text] of (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").entries()) {
    if (!text.trim()) continue;
    const invalid = (reason: string): never => { throw new Error(`Invalid operation journal at line ${index + 1}: ${reason}; restore or investigate before sending`); };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { invalid("malformed JSON"); }
    const parsed = journalLine.safeParse(raw);
    if (!parsed.success) invalid("unsupported record shape");
    const line = parsed.data!;
    if ("allocation" in line) {
      let message: ReturnType<typeof parseAllocation>;
      try { message = parseAllocation(line.allocation); } catch { invalid("invalid allocation signature"); }
      const m = message!;
      const remainingAtRecord = Date.parse(m.expiresAt) - Date.parse(line.at);
      if (!Number.isFinite(remainingAtRecord) || remainingAtRecord <= 0 || remainingAtRecord > 3_600_000) invalid("invalid allocation authorization window");
      const nonceKey = `${m.ownerPublicKey}:${m.nonce}`;
      if (allocationNonces.has(nonceKey)) invalid("repeated allocation authorization");
      allocationNonces.add(nonceKey);
      const source = bindings.get(m.sourceBindingKey);
      const targetKey = requestKey(m.target.actor, m.target.requestId);
      if (m.agentId !== agentId() || line.idempotencyKey !== targetKey || targetKey === m.sourceBindingKey ||
          !source?.fundingOnly || source.refused || source.paymentAccount !== m.paymentAccount || source.publicKey !== m.paymentPublicKey ||
          m.target.approved.asset !== source.approved.asset || m.target.approved.network !== source.approved.network ||
          source.approved.amount !== m.sourceUsdcAmount || ops.has(source.idempotencyKey) || ops.has(targetKey)) invalid("allocation source or target mismatch");
      for (const stage of ["open", "usdc"] as const) {
        const proof = stage === "open" ? m.sourceOpen : m.sourceUsdc;
        const actual = source!.landed[stage], op = ops.get(marketStageKey(source!.idempotencyKey, stage));
        if (!actual || actual.correlationId !== proof.correlationId || actual.destinationTxHash !== proof.destinationTxHash ||
            actual.finalHeight !== proof.finalHeight || op?.status !== "SUCCESS" || op.request.recipient !== m.paymentAccount ||
            (stage === "usdc" && op.request.amount !== m.sourceUsdcAmount)) invalid("allocation lacks exact source proofs");
      }
      const previous = source!.allocation && parseAllocation(source!.allocation);
      if (previous && allocationIdentity(previous) !== allocationIdentity(m)) invalid("allocation changed its source or target");
      const target = bindings.get(targetKey);
      if (!previous && (target || [...bindings.values()].some(b => b.paymentAccount === m.paymentAccount && b !== source)))
        invalid("allocation conflicts with an existing binding");
      if (previous && (!target?.fundingSource || target.fundingOnly)) invalid("allocation renewal has no target");
      source!.allocation = line.allocation;
      if (target) target.fundingSource = line.allocation;
      else bindings.set(targetKey, { at: line.at, idempotencyKey: targetKey, ...m.target,
        paymentAccount: m.paymentAccount, publicKey: m.paymentPublicKey, landed: {}, fundingSource: line.allocation });
      continue;
    }
    if ("binding" in line) {
      if (bindings.has(line.idempotencyKey)) invalid("duplicate market binding");
      if (ops.has(line.idempotencyKey) || ops.has(marketStageKey(line.idempotencyKey, "open")) ||
          ops.has(marketStageKey(line.idempotencyKey, "usdc"))) invalid("market binding followed its money operation");
      bindings.set(line.idempotencyKey, { at: line.at, idempotencyKey: line.idempotencyKey,
        ...line.binding, landed: {} });
      continue;
    }
    if ("marketLanding" in line) {
      const binding = bindings.get(line.idempotencyKey);
      if (!binding) invalid("market landing without binding");
      const { stage, correlationId, destinationTxHash, finalHeight } = line.marketLanding;
      if (binding!.refused) invalid("market binding was already refused");
      if (binding!.landed[stage]) invalid("duplicate market landing");
      if (landedTransactions.has(destinationTxHash)) invalid("market destination transaction reused for another funding stage");
      const op = ops.get(marketStageKey(line.idempotencyKey, stage));
      if (!op || op.kind !== "market-topup" || op.method !== "withdraw" || op.submissionState !== "SUBMISSION_ATTEMPTED" ||
          op.correlationId !== correlationId || op.status !== "SUCCESS" || op.request.recipient !== binding!.paymentAccount)
        invalid("market landing has no matching successful submitted top-up");
      if (line.marketLanding.bindingRefusal && ops.has(line.idempotencyKey))
        invalid("market binding refusal contradicts payment preparation");
      binding!.landed[stage] = { correlationId, destinationTxHash, finalHeight };
      landedTransactions.add(destinationTxHash);
      if (line.marketLanding.bindingRefusal) binding!.refused = line.marketLanding.bindingRefusal;
      continue;
    }
    if (line.request !== undefined) {
      const stage = /^(.*):market-(open|usdc)$/.exec(line.idempotencyKey);
      if (stage) {
        const binding = bindings.get(stage[1]!);
        if (!binding || !matchesBoundStage(binding, stage[2] as MarketStage, line))
          invalid("market funding stage differs from its binding");
      }
      const bound = bindings.get(line.idempotencyKey);
      if (bound?.refused) invalid("market binding was refused before payment preparation");
      if (bound && !matchesBoundPayment(bound, line))
        invalid("market payment differs from its binding");
      if (ops.has(line.idempotencyKey)) invalid("duplicate preparation");
      if (line.method === "limit_order_cancel" && line.journalVersion !== 2) invalid("cancellation without a versioned claim");
      ops.set(line.idempotencyKey, { ...line, ...("journalVersion" in line && line.journalVersion === 2 && { submissionState: "PREPARED" as const }) });
      if (line.correlation_id === undefined) continue;
    }
    const op = ops.get(line.idempotencyKey);
    if (!op) invalid("record without preparation");
    const existing = op!;
    if (line.authorization !== undefined) {
      if (existing.journalVersion !== undefined) invalid("legacy authorization metadata for a versioned operation");
      continue;
    }
    if (line.submissionState !== undefined) {
      if (existing.journalVersion !== 2 || existing.submissionState !== "PREPARED" || existing.correlationId || isResolved(existing))
        invalid("invalid submission claim");
      existing.submissionState = line.submissionState;
    }
    if (line.refused !== undefined) {
      if (existing.method === "limit_order_cancel" && existing.submissionState === "SUBMISSION_ATTEMPTED")
        invalid("claimed cancellation cannot be refused without final payout evidence");
      if (existing.correlationId || existing.status || (existing.refused !== undefined && existing.refused !== line.refused)) invalid("refusal contradicts prior evidence");
      if (line.refused === "never_submitted" && (existing.journalVersion !== 2 || existing.submissionState !== "PREPARED")) invalid("submission cannot be inferred absent");
      existing.refused = line.refused;
    }
    if (line.correlation_id !== undefined) {
      if (existing.method === "limit_order_cancel") invalid("cancellation acceptance has no final outcome correlation");
      if (existing.refused !== undefined || (existing.journalVersion === 2 && (existing.submissionState !== "SUBMISSION_ATTEMPTED" || !line.status))) invalid("outcome without submission claim");
      if (existing.correlationId && existing.correlationId !== line.correlation_id) invalid("operation identity changed");
      if (isResolved(existing) && existing.status !== line.status) invalid("terminal outcome changed");
      const owner = correlations.get(line.correlation_id);
      if (owner && owner !== line.idempotencyKey) invalid("operation identity shared by different preparations");
      correlations.set(line.correlation_id, line.idempotencyKey);
      Object.assign(existing, { correlationId: line.correlation_id, status: line.status });
    }
    if (line.cancelFinal === true) {
      if (existing.method !== "limit_order_cancel" || existing.journalVersion !== 2 || existing.submissionState !== "SUBMISSION_ATTEMPTED"
        || existing.refused || existing.correlationId || existing.status || existing.cancelFinal)
        invalid("cancel completion without one claimed cancellation");
      existing.cancelFinal = true;
    }
  }
  return { ops, bindings };
}

/** Market hire identity is durable from the first top-up, separately from money-operation projection. */
export function readMarketBindings(): MarketBinding[] {
  return [...readJournal().bindings.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** Every operation in the log, oldest first, folded with outcomes and invoice operations. */
export function readOps(): Op[] {
  const { ops } = readJournal();
  for (const op of invoiceOperations()) {
    if (ops.has(op.idempotencyKey)) throw new Error("Operation exists in both stores; reconcile before executing");
    ops.set(op.idempotencyKey, op);
  }
  return [...ops.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** Write the exact hire identity before any funding. Caller holds the money lock. */
export function recordMarketBinding(input: Omit<MarketBinding, "at" | "landed" | "refused" | "allocation" | "fundingSource">) {
  const line = { at: new Date().toISOString(), idempotencyKey: input.idempotencyKey, kind: "market-binding" as const,
    journalVersion: 3 as const, binding: { actor: input.actor, requestId: input.requestId, brief: input.brief,
      approved: input.approved, paymentAccount: input.paymentAccount, publicKey: input.publicKey,
      ...(input.fundingOnly && { fundingOnly: true as const }) } };
  if (!marketBindingLine.safeParse(line).success) throw new Error("Market binding identity or terms are invalid");
  if (readMarketBindings().some(binding => binding.idempotencyKey === input.idempotencyKey))
    throw new Error("Market binding identity already recorded");
  const prior = readOps();
  if (prior.some(op => op.idempotencyKey === input.idempotencyKey ||
      op.idempotencyKey === marketStageKey(input.idempotencyKey, "open") ||
      op.idempotencyKey === marketStageKey(input.idempotencyKey, "usdc")))
    throw new Error("Market binding followed its money operation");
  appendSynced(opsLog(), line);
}

/** Caller holds the money lock and has verified live owner authority and source receipts. */
export function recordMarketAllocation(allocation: SignedAllocation) {
  const message = parseAllocation(allocation);
  if (Date.parse(message.expiresAt) <= Date.now() || Date.parse(message.expiresAt) > Date.now() + 3_600_000)
    throw new Error("Allocation authorization must be live and within one hour");
  const line = { at: new Date().toISOString(), idempotencyKey: requestKey(message.target.actor, message.target.requestId),
    kind: "market-allocation", journalVersion: 4, allocation };
  // Validate the prospective replay before appending; malformed authority must never poison the journal.
  const original = readMarketBindings();
  const source = original.find(b => b.idempotencyKey === message.sourceBindingKey);
  if (!source?.fundingOnly || source.refused || !source.landed.open || !source.landed.usdc ||
      source.paymentAccount !== message.paymentAccount || source.publicKey !== message.paymentPublicKey ||
      source.approved.amount !== message.sourceUsdcAmount || message.agentId !== agentId() ||
      source.approved.asset !== message.target.approved.asset || source.approved.network !== message.target.approved.network)
    throw new Error("Allocation source is not a fully proven isolated observation");
  for (const stage of ["open", "usdc"] as const) {
    const proof = stage === "open" ? message.sourceOpen : message.sourceUsdc;
    const actual = source.landed[stage]!;
    if (JSON.stringify(actual) !== JSON.stringify(proof)) throw new Error("Allocation source proof changed");
    const op = readOps().find(o => o.idempotencyKey === marketStageKey(source.idempotencyKey, stage));
    if (!op || op.status !== "SUCCESS" || op.request.recipient !== message.paymentAccount ||
        stage === "usdc" && op.request.amount !== message.sourceUsdcAmount) throw new Error("Allocation source amount differs");
  }
  const targetKey = line.idempotencyKey;
  const target = original.find(b => b.idempotencyKey === targetKey);
  if (!source.allocation && target) throw new Error("Allocation target is already bound");
  if (readOps().some(o => o.idempotencyKey === targetKey || o.idempotencyKey === source.idempotencyKey)) throw new Error("Payment already recorded; follow its original status");
  if (source.allocation) {
    if (allocationIdentity(parseAllocation(source.allocation)) !== allocationIdentity(message)) throw new Error("Allocation target cannot change");
    if (JSON.stringify(source.allocation) === JSON.stringify(allocation)) return;
  } else if (original.some(b => b.paymentAccount === source.paymentAccount && b.idempotencyKey !== source.idempotencyKey))
    throw new Error("Another binding owns this key");
  if (targetKey === source.idempotencyKey) throw new Error("Funding-only binding cannot become a hire");
  if (readFileSync(opsLog(), "utf8").split("\n").filter(Boolean).some(text => {
    const row = JSON.parse(text);
    return row.kind === "market-allocation" && row.allocation.publicKey === allocation.publicKey && row.allocation.nonce === allocation.nonce;
  })) throw new Error("Allocation nonce was already recorded");
  appendSynced(opsLog(), line);
}

/** Record only a verified, final destination receipt for this exact submitted funding stage. Caller holds the lock. */
export function recordMarketLanding(input: { bindingKey: string; stage: MarketStage; correlationId: string;
  destinationTxHash: string; finalHeight: string; bindingRefusal?: "funding_shortfall" }) {
  const line = { at: new Date().toISOString(), idempotencyKey: input.bindingKey, kind: "market-landing" as const,
    journalVersion: 3 as const, marketLanding: { stage: input.stage, correlationId: input.correlationId,
      destinationTxHash: input.destinationTxHash, finalHeight: input.finalHeight,
      ...(input.bindingRefusal && { bindingRefusal: input.bindingRefusal }) } };
  if (!marketLandingLine.safeParse(line).success) throw new Error("Market landing evidence is invalid");
  const binding = readMarketBindings().find(binding => binding.idempotencyKey === input.bindingKey);
  if (!binding) throw new Error("Market landing has no binding or stage operation");
  if (binding.refused) throw new Error("Market binding was already refused");
  if (binding.landed[input.stage]) throw new Error("Market landing already recorded");
  if (readMarketBindings().some(item => Object.values(item.landed).some(landing =>
    landing?.destinationTxHash === input.destinationTxHash)))
    throw new Error("Market destination transaction already proved another funding stage");
  if (input.bindingRefusal && readOps().some(op => op.idempotencyKey === input.bindingKey))
    throw new Error("Market binding refusal contradicts payment preparation");
  const op = readOps().find(op => op.idempotencyKey === marketStageKey(input.bindingKey, input.stage));
  if (!op || op.kind !== "market-topup" || op.method !== "withdraw" || op.submissionState !== "SUBMISSION_ATTEMPTED" ||
      op.correlationId !== input.correlationId || op.status !== "SUCCESS" || op.request.recipient !== binding.paymentAccount)
    throw new Error("Market landing has no matching submitted successful stage operation or correlation");
  appendSynced(opsLog(), line);
}

/** A send or approval this server holds before anything reaches the provider. */
export class AuthorizationHeld extends Error {
  constructor(message: string) { super(`Execution held: ${message}`); }
}

/** Only recognized non-execution responses resolve a claimed submission. The SDK also wraps
 * proxy HTML and empty errors as AgentApiError with retryable=false: that is not provider evidence.
 * Unknown codes stay unresolved until their non-execution semantics have been established. */
export function provenRefusal(error: unknown): string | undefined {
  if (!(error instanceof AgentApiError) || error.retryable || !error.errors.length) return undefined;
  const codes = error.status >= 500 ? PROVEN_5XX : error.status >= 400 ? PROVEN_4XX : undefined;
  if (!codes || !error.errors.every((entry) => codes.has(entry.code) && entry.status === String(error.status) && entry.meta?.retryable !== true)) return undefined;
  return error.code;
}
const PROVEN_4XX = new Set(["policy_denied", "spend_budget_exceeded"]);
const PROVEN_5XX = new Set(["route_unavailable", "quote_unavailable", "spend_price_unavailable"]);

/** Called under the money lock immediately before the sole send site. */
export function claimSubmission(key: string, request: unknown) {
  if (claimInvoiceSubmission(key, request)) return;
  const op = readOps().find((op) => op.idempotencyKey === key);
  if (!op || JSON.stringify(op.request) !== JSON.stringify(request)) throw new Error("Operation terms changed");
  record({ idempotencyKey: key, submissionState: "SUBMISSION_ATTEMPTED" });
}

/** Only the next money-lock holder may retire abandoned v2 preparations. A claimed but unsent
 * cancellation keeps its original journal identity so an explicit cancel request can finish it. */
export function resolveUnsubmitted() {
  for (const op of readOps()) {
    if (!op.invoiceId && op.method !== "limit_order_cancel" && op.journalVersion === 2 && op.submissionState === "PREPARED" &&
        !op.correlationId && !op.status && !isResolved(op))
      record({ idempotencyKey: op.idempotencyKey, refused: "never_submitted" });
  }
}
