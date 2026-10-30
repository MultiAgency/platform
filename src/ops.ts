import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { agentId } from "./env.js";
import { appendSynced, mkdirSynced } from "./synced.js";
import { claimInvoiceSubmission, invoiceOperations, recordInvoiceOperation, type PaymentState } from "./invoice-store.js";

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

export type Method = "swap" | "transfer" | "shield" | "unshield" | "withdraw";

/** What a request line records beside the request: the mandate it ran under and what it was worth. */
type Context = {
  policyRevision?: number | null;
  /** `mandateDigest` of the policy in force when the request was sent. */
  policyDigest?: string | null;
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
  | { at?: string; idempotencyKey: string; submissionState: "SUBMISSION_ATTEMPTED" };

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
};

const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

/** A provider status after which nothing more happens to the operation. */
export const isTerminal = (status: string) => TERMINAL.has(status);

/** Outcome proven: settled terminally, or refused before anything was sent. */
export const isResolved = (op: Op) => op.refused !== undefined || (op.status !== undefined && isTerminal(op.status));

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
  if ("request" in line && line.journalVersion === 2 && readOps().some((op) => op.idempotencyKey === line.idempotencyKey))
    throw new Error("Operation identity already recorded");
  if ("submissionState" in line) {
    const op = readOps().find((op) => op.idempotencyKey === line.idempotencyKey);
    if (!op || op.invoiceId || op.journalVersion !== 2 || op.submissionState !== "PREPARED" || op.correlationId || isResolved(op))
      throw new Error("Operation cannot be claimed; replay is blocked");
  }
  if ("correlation_id" in line) {
    const existing = readOps().find((op) => op.idempotencyKey === line.idempotencyKey);
    if (existing?.correlationId && existing.correlationId !== line.correlation_id) {
      throw new Error("Provider operation identity changed");
    }
    if (existing && isResolved(existing) && line.status !== existing.status) {
      return; // never reopen a proven terminal outcome with contradictory evidence
    }
  }
  if (recordInvoiceOperation(line)) return;
  appendSynced(opsLog(), { at: new Date().toISOString(), ...line });
}

/** Records a logged operation's latest status, found by its correlation id. */
export function settle(correlationId: string, status: string) {
  const op = readOps().find((o) => o.correlationId === correlationId);
  if (op) record({ idempotencyKey: op.idempotencyKey, correlation_id: correlationId, status });
}

const nonempty = z.string().min(1);
const identity = { idempotencyKey: nonempty, at: z.string().optional() };
// Unknown metadata is ignored. Known lifecycle fields cannot be silently discarded
// by matching a different record shape.
const noOutcome = { correlation_id: z.never().optional(), status: z.never().optional(), refused: z.never().optional(), submissionState: z.never().optional() };
const preparationLine = z.object({ ...identity, ...noOutcome, at: z.string(), kind: nonempty, request: z.record(z.string(), z.unknown()),
    authorization: z.never().optional(),
    // `withdraw` since P3b: a build before it can't read a journal holding one (docs/operations.md, rollback).
    method: z.enum(["swap", "transfer", "shield", "unshield", "withdraw"]).optional(), journalVersion: z.literal(2).optional(),
    policyRevision: z.number().nullable().optional(), policyDigest: z.string().nullable().optional(),
    usdIn: z.number().nullable().optional(), planId: z.string().optional() });
const outcome = { ...identity, ...noOutcome, request: z.never().optional(), journalVersion: z.never().optional(), authorization: z.never().optional() };
const journalLine = z.union([
  preparationLine,
  // Legacy snapshots could combine the request and its observed provider identity.
  preparationLine.extend({ journalVersion: z.never().optional(), correlation_id: nonempty, status: nonempty.optional() }),
  z.object({ ...outcome, submissionState: z.literal("SUBMISSION_ATTEMPTED") }),
  z.object({ ...outcome, refused: nonempty }),
  // Older logs may have a correlation ID without a status: still unresolved, never inferred terminal.
  z.object({ ...outcome, correlation_id: nonempty, status: nonempty.optional() }),
  // Historical authorization snapshots are metadata, never submission or settlement evidence.
  z.object({ ...outcome, at: z.string(), authorization: z.object({ version: z.literal(1) }).passthrough() }).strict(),
]);

/** Every operation in the log, oldest first, folded with the outcomes recorded for it. */
export function readOps(): Op[] {
  const log = opsLog();
  const ops = new Map<string, Op>();
  const correlations = new Map<string, string>();
  for (const [index, text] of (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").entries()) {
    if (!text.trim()) continue;
    const invalid = (reason: string): never => { throw new Error(`Invalid operation journal at line ${index + 1}: ${reason}; restore or investigate before sending`); };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { invalid("malformed JSON"); }
    const parsed = journalLine.safeParse(raw);
    if (!parsed.success) invalid("unsupported record shape");
    const line = parsed.data!;
    if (line.request !== undefined) {
      if (ops.has(line.idempotencyKey)) invalid("duplicate preparation");
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
      if (existing.correlationId || existing.status || (existing.refused !== undefined && existing.refused !== line.refused)) invalid("refusal contradicts prior evidence");
      if (line.refused === "never_submitted" && (existing.journalVersion !== 2 || existing.submissionState !== "PREPARED")) invalid("submission cannot be inferred absent");
      existing.refused = line.refused;
    }
    if (line.correlation_id !== undefined) {
      if (existing.refused !== undefined || (existing.journalVersion === 2 && (existing.submissionState !== "SUBMISSION_ATTEMPTED" || !line.status))) invalid("outcome without submission claim");
      if (existing.correlationId && existing.correlationId !== line.correlation_id) invalid("operation identity changed");
      if (isResolved(existing) && existing.status !== line.status) invalid("terminal outcome changed");
      const owner = correlations.get(line.correlation_id);
      if (owner && owner !== line.idempotencyKey) invalid("operation identity shared by different preparations");
      correlations.set(line.correlation_id, line.idempotencyKey);
      Object.assign(existing, { correlationId: line.correlation_id, status: line.status });
    }
  }
  for (const op of invoiceOperations()) {
    if (ops.has(op.idempotencyKey)) throw new Error("Operation exists in both stores; reconcile before executing");
    ops.set(op.idempotencyKey, op);
  }
  return [...ops.values()].sort((a, b) => a.at.localeCompare(b.at));
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

/** Only the next money-lock holder may retire abandoned v2 preparations. Never infer legacy safety. */
export function resolveUnsubmitted() {
  for (const op of readOps()) {
    if (!op.invoiceId && op.journalVersion === 2 && op.submissionState === "PREPARED" &&
        !op.correlationId && !op.status && !isResolved(op))
      record({ idempotencyKey: op.idempotencyKey, refused: "never_submitted" });
  }
}
