import { gatewayQueries } from "../../app/queries";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useViewer } from "../../app/viewer";
import { useAgent } from "../../app/agent-context";
import { useSiblings } from "../../shared/names";
import { APPROVAL_WINDOW_MS, exactPayment, queries, useCountdown } from "../../shared/lib";
import { useOwnerAction, useSigner } from "../owner/owner";
import { paymentOwnerState } from "./payment-owner-state";
import { paymentProgress } from "./payment-progress";
import { paymentStages } from "./payment-stages";
import { usePaymentStatus } from "./use-payment-status";
import { accessDenied } from "../../shared/read-failure";
import { visibleProposals, useAccessState } from "../../shared/access";
import type { PaymentRecord as Known } from "./payment-records";

export function usePayment(id: string, knownPayment: Known) {
  const access = useAccessState();
  const { data, setup } = useAgent();
  const viewer = useViewer();
  const { self } = useSiblings();
  const [settled, setSettled] = useState(false);
  const poll = settled ? false : 5_000;
  const pending = useQuery({ ...queries.ownerPending, refetchInterval: poll });
  // The proposals of the DAO that owns this agent, when one does: an owner account files none.
  const dao = self?.dao ? self.owner : undefined;
  const proposals = useQuery({ ...gatewayQueries.proposals(dao),
    enabled: Boolean(dao), refetchInterval: settled ? false : 10_000 });
  const ownerActions = useQuery({ ...queries.ownerActions, refetchInterval: poll, retry: false });
  const action = useOwnerAction(setup);
  const { canSign } = useSigner(setup);

  const status = usePaymentStatus(id);
  // The latest approval filed for this payment that hasn't expired, else the latest of any.
  const approvals = (pending.data ?? []).filter((p) => p.payment?.correlationId === id);
  const approval = approvals.filter((p) => p.state !== "expired").at(-1) ?? approvals.at(-1);
  const vote = useQuery({
    ...queries.ownerStatus(approval?.correlationId ?? ""),
    enabled: Boolean(approval),
    // Submitted, expired and failed are where a vote ends; anything else (unknown included) may still change.
    refetchInterval: (q) => settled || (q.state.data && ["submitted", "expired", "failed"].includes(q.state.data.stage)) ? false : 4_000,
  });
  const proposal = approval && !accessDenied(proposals.error)
    ? visibleProposals(proposals.data ?? [], access).find(p => p.hash === approval.hash) : undefined;
  // The signing window comes from the owner action itself: the API keeps it open 5 to 10 minutes.
  const windowLeft = useCountdown(vote.data?.stage === "voting" ? vote.data.expiresAt : undefined);

  const payment = { at: status.data?.createdAt ?? knownPayment.at, request: status.data?.request ?? knownPayment.request, approvalId: status.data?.approvalId ?? knownPayment.approvalId };
  const expiresAt = status.data?.expiresAt ?? (payment.at ? new Date(Date.parse(payment.at) + APPROVAL_WINDOW_MS).toISOString() : null);
  const s = status.data?.status;
  const paid = s === "SUCCESS";
  const failed = s === "FAILED" || s === "REFUNDED";
  const isHeld = s === "PENDING_APPROVAL";
  const voted = vote.data?.stage === "submitted" ? vote.data : null;
  const outcome = voted && "status" in voted ? voted.status : undefined;
  const { records, recovering, approved, rejected } = paymentOwnerState(ownerActions.data ?? [], id);
  const expired = outcome === "EXPIRED" || approval?.state === "expired";
  const final = paid || failed;
  useEffect(() => setSettled(final), [final]);
  // Each stage needs its own evidence; a paid transfer does not prove approval history.
  const heldEvidence = Boolean(payment.approvalId || approval || records.length);
  const step = paymentStages({ heldEvidence, proposal, approved, rejected, recovering, paid, failed, s, isHeld });
  const VOTE_WORDS: Record<string, string> = { InProgress: "voting", Approved: "approved", Rejected: "rejected", Removed: "removed", Expired: "expired" };
  const deciding = action.busy || Boolean(recovering) || approved || rejected || Boolean(approval && !expired && !approved && !rejected);
  const approvable = isHeld && ownerActions.isSuccess && !ownerActions.error && pending.isSuccess && !deciding && Boolean(expiresAt && Date.now() < Date.parse(expiresAt)) && !status.error && !pending.error && !vote.error;
  const decide = (verdict: "approve" | "reject") =>
    payment.approvalId && action.run({ type: "approval_vote", approvalId: payment.approvalId, verdict, correlationId: id });

  const what = payment.request ? exactPayment(payment.request, data.book) : `A payment${proposal ? ` approved by proposal #${proposal.id}` : ""}`;
  const signer = dao ?? "the owner";
  const progress = paymentProgress({ status: s, statusError: Boolean(status.error), ownerError: Boolean(ownerActions.error),
    approved, rejected, recovering: recovering?.stage });

  return { viewer, pending, dao, proposals, ownerActions, action, canSign, status, approval, vote, proposal, windowLeft, payment, expiresAt, s, paid, failed, isHeld, recovering, approved, rejected, expired, final, heldEvidence, step, VOTE_WORDS, approvable, decide, what, signer, progress };
}
