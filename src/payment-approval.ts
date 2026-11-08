import { createHash } from "node:crypto";
import { api } from "./api.js";
import { authorize } from "./authorize.js";
import { getInvoice } from "./invoice-store.js";
import { canonical, mandateDigest } from "./mandate.js";
import { AuthorizationHeld, readOps } from "./ops.js";

export type PaymentApproval = { approvalId: string; correlationId: string; verdict: "approve" | "reject";
  requestHash: string; key?: string; invoiceRevision?: number; policyDigest?: string };

/** The terms a provider approval names: a confidential transfer, or withdrawal to NEAR, of `amount` of `token` to `to`. */
type Terms = { to: string; token: string; amount: string };
type Flow = "transfer" | "withdraw";
/** A held withdrawal's `request_data` as observed on mainnet (2026-10-30, docs/mainnet-log.md). */
const WITHDRAWAL_FIELDS = new Set(["to", "chain", "token", "amount", "destination_asset"]);

/**
 * The wallet provider's hash of a confidential transfer or withdrawal: sha256 of its canonical operation
 * (`shared-tee-helpers` `wallet_policy::request_hash`, `Op::Confidential`), recomputed here so the
 * readable terms are proven to be the ones the approval releases. A withdrawal's is the transfer's with
 * `flow` `withdraw` (mainnet, 2026-10-30; docs/enforcement.md).
 */
const requestHash = (terms: Terms, flow: Flow) =>
  createHash("sha256").update(canonical({ ...terms, chain: "near", flow, kind: "confidential" })).digest("hex");

/**
 * Checks a vote on one held payment against the provider's own evidence, so any instance of the
 * agent can approve, including an approve-only one (EXECUTOR=off) that never saw the payment sent:
 * the approval and the execution must name each other and this agent's wallet; an approval must name
 * a confidential transfer whose terms hash to the provider's request hash, to a payee, asset and
 * amount the applied policy allows. A payment this instance recorded must also match its record and
 * any invoice behind it must be unrevised. Anything that can't be verified refuses, with the reason.
 * `terms` are the approved transfer's, proven against the provider's hash; null for a reject, which releases nothing.
 */
export async function checkPaymentApproval(input: Pick<PaymentApproval, "approvalId" | "correlationId" | "verdict">, saved?: PaymentApproval) {
  const id = process.env.AGENT_ID;
  if (!id) throw new AuthorizationHeld("agent missing");
  const options = { signal: AbortSignal.timeout(10_000) };
  const approving = input.verdict === "approve";
  const [approval, status, wallet, view] = await Promise.all([
    api.getApproval(id, input.approvalId, options), api.getStatus(input.correlationId, options), api.getWallet(id, options),
    approving ? api.getPolicy(id, options) : undefined,
  ]);
  if (status.correlation_id !== input.correlationId || status.agent_id !== id || status.status !== "PENDING_APPROVAL" || !("details" in status) ||
      !("approval_id" in status.details) || status.details.approval_id !== input.approvalId || approval.approval_id !== input.approvalId ||
      approval.wallet_id !== wallet.wallet_id || approval.status !== "PENDING" || Date.parse(approval.expires_at) <= Date.now() ||
      !Number.isFinite(Date.parse(approval.expires_at)) || !approval.request_hash)
    throw new AuthorizationHeld("approval does not identify this pending agent payment");
  let binding: PaymentApproval = { approvalId: input.approvalId, correlationId: input.correlationId, verdict: input.verdict, requestHash: approval.request_hash };
  const flow: Flow | null = status.type === "transfer" || status.type === "withdraw" ? status.type : null;
  if (approving && !flow) throw new AuthorizationHeld(`approving a held ${status.type} is not supported`);

  // Rejecting releases nothing, so it needs no more than the identity checks above.
  let invoiceId: string | undefined;
  let terms: { recipient: string; asset: string; amount: string; chain?: "near" } | null = null;
  if (approving) {
    if (approval.request_type !== "confidential") throw new AuthorizationHeld(`approving a ${approval.request_type} request is not supported`);
    const { to, token, amount, chain, destination_asset } = approval.request_data as Record<string, unknown>;
    if (typeof to !== "string" || typeof token !== "string" || typeof amount !== "string" || !/^[1-9]\d*$/.test(amount))
      throw new AuthorizationHeld("provider approval terms are incomplete: recipient, asset or amount missing");
    if (flow === "withdraw") {
      if (typeof chain !== "string" || typeof destination_asset !== "string")
        throw new AuthorizationHeld("provider approval terms are incomplete: a withdrawal's chain or destination asset missing");
      if (chain !== "near") throw new AuthorizationHeld("a held withdrawal is approved only to chain near");
      // The request hash doesn't cover what the payee receives, so the owner's signature can't bind it: it must at least
      // read as the token withdrawn, or the approval is refused (docs/enforcement.md, "Payout withdrawals").
      if (destination_asset !== token) throw new AuthorizationHeld("a held withdrawal's destination asset isn't the token withdrawn");
      // Only the fields observed on mainnet (2026-10-30): any other, such as a memo, the hash wouldn't cover.
      const outside = Object.keys(approval.request_data).filter((key) => !WITHDRAWAL_FIELDS.has(key));
      if (outside.length) throw new AuthorizationHeld(`a held withdrawal's approval names fields outside the observed set: ${outside.join(", ")}`);
    }
    if (requestHash({ to, token, amount }, flow!) !== approval.request_hash)
      throw new AuthorizationHeld("provider approval terms don't match its request hash");
    terms = { recipient: to, asset: token, amount, ...(flow === "withdraw" && { chain: "near" as const }) };

    if (!view) throw new AuthorizationHeld("policy unavailable");
    const request = { recipient: to, asset: token, amount, confidential: true };
    const refusal = authorize(flow === "withdraw" ? { method: "withdraw", request: { ...request, chain: "near" } } : { method: "transfer", request },
      { purpose: "approval", facts: { now: Date.now(), agentId: id, view, grant: undefined } });
    if (refusal) throw new AuthorizationHeld(`${refusal.code}: ${refusal.message}`);
    const policy = view.policy!;

    // A payment this instance sent must be exactly the one approved, and its invoice unrevised.
    const op = readOps().find((o) => o.correlationId === input.correlationId);
    if (op && (op.method !== flow || op.request.recipient !== to || op.request.asset !== token || op.request.amount !== amount))
      throw new AuthorizationHeld("provider approval terms do not match the recorded payment");
    invoiceId = op?.invoiceId;
    const invoice = invoiceId ? getInvoice(invoiceId) : undefined;
    if (invoiceId && (!invoice || invoice.review)) throw new AuthorizationHeld("invoice revision invalidated approval");
    binding = { ...binding, policyDigest: mandateDigest(policy),
      ...(op && { key: op.idempotencyKey }), ...(invoice && { invoiceRevision: invoice.revision }) };
  }
  if (saved && canonical(saved) !== canonical(binding)) throw new AuthorizationHeld("approval binding changed");
  const assertCurrent = () => {
    if (Date.parse(approval.expires_at) <= Date.now()) throw new AuthorizationHeld("approval expired");
    if (invoiceId) {
      const invoice = getInvoice(invoiceId);
      if (!invoice || invoice.review || invoice.revision !== binding.invoiceRevision) throw new AuthorizationHeld("payment changed before approval submission");
    }
  };
  assertCurrent();
  return { binding, assertCurrent, terms };
}
