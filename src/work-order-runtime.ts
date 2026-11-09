import { api } from "./api.js";
import { depositAddress } from "./agent.js";
import { agentId } from "./env.js";
import { adoptStagedGrant, liveGrant } from "./grants.js";
import { rawBalance } from "./holdings.js";
import { mandateDigest } from "./mandate.js";
import { file, mine } from "./invoices.js";
import { getInvoice, invoiceId } from "./invoice-store.js";
import { ownerActions, prepare, status, submit, type OwnerAction } from "./owner-intents.js";
import { held } from "./payouts.js";
import { currentWorkOrder, workOrderInvoice, workOrderPolicy } from "./work-order-store.js";
import { WorkOrderRefusal, workOrderCommand, type WorkOrderCommand, type WorkOrderSnapshot } from "./work-order-protocol.js";

function order() {
  const value = currentWorkOrder();
  if (!value) throw new Error("This is not a work order executor.");
  return value;
}

export async function workOrderSnapshot(): Promise<WorkOrderSnapshot> {
  const record = order();
  const base: WorkOrderSnapshot = { order: record, agentId: process.env.AGENT_ID ?? null,
    wallet: null, balance: null, policyReady: false, grant: null, invoice: null,
    ownerActions: ownerActions(), approval: null, error: null };
  if (!base.agentId) return base;
  // Retained terms and payment identity survive unavailable provider observations.
  const stored = getInvoice(invoiceId({ payee: record.payee, submission: record.id }));
  try {
    const [agent, view, grants, balances, invoices] = await Promise.all([
      api.getAgent(base.agentId), api.getPolicy(base.agentId), api.listGrants(base.agentId),
      api.getBalances(base.agentId, { source: "confidential" }), mine(record.payee),
    ]);
    if (agent.owner?.type !== "near" || agent.owner.account_id !== record.owner.account_id || agent.owner.public_key !== record.owner.public_key)
      throw new Error("The work order agent has a different owner.");
    adoptStagedGrant(grants);
    const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
    const matching = grant && grant.label === "invoices" && Date.parse(grant.expires_at) === Date.parse(record.until);
    base.wallet = agent.wallet?.near_account_id ?? null;
    base.balance = rawBalance(balances, record.asset).toString();
    base.policyReady = view.status === "APPLIED" && view.provider_policy_synced && Boolean(view.policy &&
      mandateDigest(view.policy) === mandateDigest(workOrderPolicy(record)));
    base.grant = matching ? { id: grant.grant_id, expiresAt: grant.expires_at } : null;
    base.invoice = invoices.find(invoice => invoice.id === invoiceId({ payee: record.payee, submission: record.id })) ?? null;
    if (stored?.operation.correlationId) {
      const approval = (await held({ complete: true })).find(payment => payment.correlationId === stored.operation.correlationId);
      base.approval = approval ? { correlationId: approval.correlationId, approvalId: approval.approvalId } : null;
    }
  } catch {
    // Never present a failed read as an unfunded or unpaid order, or substitute the parent's agent.
    base.error = "Work order observations are unavailable. Refresh its existing record before acting.";
    if (stored) base.invoice = { id: stored.id, amount: stored.amount, note: stored.note, filedAt: stored.at,
      status: "unknown", revisionConflict: stored.review };
  }
  return base;
}

function ownAction(correlationId: string) {
  if (!ownerActions().some(action => action.correlationId === correlationId)) throw new Error("Owner action not found for this work order.");
}

/** Only this fixed command set crosses the private subprocess boundary. No arbitrary RPC forwarding. */
export async function handleWorkOrderCommand(raw: WorkOrderCommand) {
  const command = workOrderCommand.parse(raw);
  const record = order();
  if (command.type === "snapshot") return workOrderSnapshot();
  if (command.type === "deposit") {
    workOrderInvoice(record, record.payee);
    const snapshot = await workOrderSnapshot();
    if (snapshot.error || !snapshot.policyReady || !snapshot.grant || snapshot.invoice)
      throw new WorkOrderRefusal("work_order_not_ready", "Authorize the work order and review its existing invoice before funding.");
    return depositAddress(record.asset);
  }
  if (command.type === "status") { ownAction(command.correlationId); return status(command.correlationId); }
  if (command.type === "submit") { ownAction(command.correlationId); return submit(command.correlationId, command.signedData); }
  if (command.type === "file") {
    if (command.payee !== record.payee) throw new Error("Work order not found.");
    const id = invoiceId({ payee: record.payee, submission: record.id });
    const existing = process.env.AGENT_ID ? getInvoice(id) : undefined;
    // After an attempt, keep observing the existing payment even after expiry; never create new work.
    if (existing && existing.operation.submissionState !== "PREPARED")
      return file({ payee: record.payee, amount: record.amount, note: record.note, submission: record.id }, command.payee);
    const input = workOrderInvoice(record, command.payee);
    const snapshot = await workOrderSnapshot();
    if (snapshot.error || !snapshot.policyReady || !snapshot.grant || snapshot.balance === null || BigInt(snapshot.balance) !== BigInt(record.amount))
      throw new WorkOrderRefusal("work_order_not_ready", "This payout is not ready: it requires signed authorization and exactly the approved funding. Review current records; do not add funds or create a replacement.");
    return file(input, command.payee);
  }
  if (command.signer === "dao" && !record.dao) throw new Error("This work order has no DAO owner.");
  if (command.signer === "wallet" && record.dao) throw new Error("This work order requires its DAO's approval.");
  const actions = ownerActions();
  if (actions.some(action => action.stage === "prepared" || action.stage === "submitted"))
    throw new Error("An owner action is already open. Follow its existing record before preparing another.");
  let action: OwnerAction;
  switch (command.action) {
    case "create":
      workOrderInvoice(record, record.payee);
      // Only a creation the owner never signed proves no agent exists: never submitted before its window closed, or settled
      // EXPIRED because the provider still awaited the signature then. What a provider FAILED leaves on chain isn't established.
      if (process.env.AGENT_ID || actions.some(action => action.type === "agent_create" && !(action.phase === "expired" ||
        (action.phase === "settled" && action.status === "EXPIRED"))))
        throw new Error("Agent creation already has a retained record. Recover it before preparing another.");
      action = { type: "agent_create", owner: record.owner, role: "payout", payees: [record.payee] };
      break;
    case "grant": {
      workOrderInvoice(record, record.payee);
      const snapshot = await workOrderSnapshot();
      if (snapshot.error || !snapshot.policyReady || snapshot.grant) throw new Error("Review the work order's policy and existing grant before authorizing.");
      action = { type: "grant_issue", label: "invoices" };
      break;
    }
    case "approve": case "reject": {
      const snapshot = await workOrderSnapshot();
      if (snapshot.error || !snapshot.approval) throw new Error("The work order's held payout could not be verified.");
      action = { type: "approval_vote", ...snapshot.approval, verdict: command.action };
      break;
    }
    case "revoke": {
      const snapshot = await workOrderSnapshot();
      if (snapshot.error || !snapshot.grant) throw new Error("The work order's live grant could not be verified.");
      action = { type: "grant_revoke", grantId: snapshot.grant.id };
      break;
    }
  }
  if (command.action !== "create") agentId();
  return prepare(action, command.signer);
}
