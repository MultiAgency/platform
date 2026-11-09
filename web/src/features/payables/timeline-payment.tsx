import { usePayments } from "./use-payments";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { usePayment } from "./use-payment";
import { PaymentOutcome } from "./payment-outcome";
import { ConfirmButton } from "../owner/confirm-button";

import { useQuery } from "@tanstack/react-query";
import { type PaymentRecord as Known } from "./payment-records";
import { PaymentEvidence } from "./payment-evidence";
import { InvoiceReview, invoiceStatus } from "./invoice-review";
import { useCanCall } from "../../app/viewer";
import { useId, useState, type ReactNode } from "react";
import { Field, FieldGroup } from "../../shared/form";
import { Field as FieldPrimitive, FieldLabel } from "@/components/ui/field";
import { Empty, EmptyContent } from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { buildPaymentQueue, filterPaymentQueue } from "./payment-queue";

import { ago, client, exactPayment, fromUnits, kindOf, minutesSeconds, queries, short } from "../../shared/lib";

import { useAgent } from "../../app/agent-context";
import { useAppHref } from "../demo/app-link";
import { Badge, Button, Card, CopyButton, Details, ErrorBox, Loading, LoadingRecords, QueryError, Section, Spinner } from "../../shared/ui";
import { refusalText } from "../../shared/words";

import { paymentOwnerState } from "./payment-owner-state";
import { WorkOrders } from "./work-orders";
import { termsInForce } from "./payment-terms";

/**
 * Payments held for the owner, each as a timeline that doubles as its receipt, approved or rejected in
 * place on one linked detail page. The Payables entry page lists compact payment records without
 * mounting every payment's live status reads. Each step reads its own record: the held payout, the owner action that
 * approves or rejects it (owner/pending names the payment and the verdict), the DAO proposal with that
 * action's hash, the action's outcome, and the provider's status for the payment (`paymentStatus`, which
 * works on an approve-only copy). Only payouts held for the owner are listed: a direct transfer has no
 * vote to show. Members only.
 *
 * Each moment also says what anyone watching the chain could learn from it, as far as it has been
 * observed: the proposal and the MPC signature are public; the payout shows no public transfer.
 */

type Status = "complete" | "current" | "upcoming" | "stopped" | "unverified";

const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);

/** What an outsider sees at one moment: a plain statement, and the public value itself when there is one. */
type Public = { text: string; value?: string };

/**
 * One moment, told twice: what members see on the left, what the chain shows on the right (under it on a
 * phone). The spine between them fills as the payment moves.
 */
function Moment({ status, when, title, detail, outsider, last, children }: {
  status: Status; when: string | null; title: string; detail?: ReactNode; outsider: Public; last?: boolean; children?: ReactNode;
}) {
  const reached = status !== "upcoming";
  const dot = {
    complete: "border-brand bg-brand",
    unverified: "border-border-strong bg-background",
    current: "border-brand bg-background ring-4 ring-brand-muted",
    upcoming: "border-border-strong bg-background",
    stopped: "border-destructive-muted-foreground bg-destructive-muted-foreground",
  }[status];
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-4 md:grid-cols-[1fr_2.5rem_1fr] md:gap-x-2">
      <div className="flex flex-col gap-1 pb-3 md:col-start-1 md:row-start-1 md:items-end md:pb-8 md:text-right col-start-2">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{reached ? (when ?? "") : "not yet"}</span>
        <h3 className={`font-heading text-base font-medium text-balance ${reached ? "" : "text-muted-foreground"}`}>{title}{status === "unverified" && <span className="text-sm text-muted-foreground"> · unverified</span>}</h3>
        {reached && detail && <p className="max-w-prose text-sm text-muted-foreground">{detail}</p>}
        {status === "current" && children}
      </div>
      <div className="relative col-start-1 row-span-2 row-start-1 flex justify-center md:col-start-2 md:row-span-1">
        {!last && <span className={`absolute top-6 -bottom-1 w-0.5 ${status === "complete" ? "bg-brand" : "bg-border"}`} />}
        <span className={`relative mt-1.5 size-3.5 rounded-full border-2 ${dot}`} />
      </div>
      <div
        className={`col-start-2 mb-6 min-w-0 self-start rounded-lg border px-3.5 py-2.5 text-sm md:col-start-3 md:row-start-1 md:mb-8 ${reached ? "" : "opacity-55"}`}
        style={{ background: "repeating-linear-gradient(-45deg, var(--muted) 0 6px, transparent 6px 12px), var(--card)" }}
      >
        <p className="text-muted-foreground"><span className="md:hidden">On chain: </span>{status === "unverified" ? "Public visibility is not established by this record." : reached ? outsider.text : "Nothing yet."}</p>
        {reached && status !== "unverified" && outsider.value && <p className="mt-1 font-mono text-xs break-all">{outsider.value}</p>}
      </div>
    </li>
  );
}

type Agreement = Awaited<ReturnType<typeof client.agreements.list>>[number];

/**
 * A held payout against its payee's newest agreed terms (`termsInForce`; src/agreements.ts `withinTerms`): what a
 * voter checks. The terms are this server's record; the vote is what enforces them.
 */
function TermsCheck({ request, agreements }: { request: Record<string, unknown>; agreements: Agreement[] }) {
  const { recipient, amount } = request as { recipient?: string; amount?: string };
  const terms = recipient ? termsInForce(agreements, recipient) : undefined;
  if (!terms || !amount || !/^\d+$/.test(amount)) return <Badge>No agreed terms on record</Badge>;
  const over = BigInt(amount) > BigInt(terms.maxAmount);
  const late = Date.now() > Date.parse(terms.until);
  return <div className="flex flex-col gap-2 text-sm">
    <p>Each invoice up to {fromUnits(terms.maxAmount, 6)} USDC · deadline {new Date(terms.until).toLocaleString()}</p>
    <Badge tone={over || late ? "warning" : "neutral"}>{over || late ? "Outside agreed terms" : "Within recorded terms"}</Badge>
    <p>These terms are checked by the voter. Invoices outside them are not automatically refused.</p>
  </div>;
}

/** One payment's timeline, with Approve and Reject in its vote step while it is held. */
function PaymentCard({ id, payment: knownPayment, agreements, historyOpen = false }: { historyOpen?: boolean; id: string; payment: Known; agreements?: Agreement[] }) {
  const app = useAppHref("payables");
  const { viewer, pending, dao, proposals, ownerActions, action, canSign, status, approval, vote, proposal, windowLeft, payment, expiresAt, s, paid, failed, isHeld, recovering, approved, rejected, expired, final, heldEvidence, step, VOTE_WORDS, approvable, decide, what, signer, progress } = usePayment(id, knownPayment);

  const denied = [status, pending, vote, ownerActions].find(query => accessDenied(query.error));
  if (denied?.error) return <QueryError error={denied.error} retry={() => denied.refetch()} />;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
        <div className="flex flex-col gap-1">
          <p className="break-words font-heading text-xl font-semibold tracking-tight">{what}</p>
          <span className="text-sm text-muted-foreground">
            Requested {payment.at ? ago(payment.at) : "at an unknown time"}{isHeld && expiresAt && ` · approval deadline ${new Date(expiresAt).toLocaleString()}${status.data?.expiresAt ? "" : " (estimated)"}`}
          </span>
        </div>
      </div>
      <PaymentOutcome progress={progress} statusError={Boolean(status.error)} paid={paid} failed={failed} />
      {payment.request && <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Current agreement terms</h3>
        {agreements ? <TermsCheck request={payment.request} agreements={agreements} /> : <p>Agreement terms unavailable. Check again before deciding.</p>}
        {!isHeld && <p className="text-sm text-muted-foreground">Current terms do not establish which terms applied to this payment.</p>}
      </div>}
      {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
      {pending.error && <QueryError error={pending.error} retry={() => pending.refetch()} />}
      {vote.error && <QueryError error={vote.error} retry={() => vote.refetch()} />}
      {proposals.error && <QueryError error={proposals.error} retry={() => proposals.refetch()} />}
      {status.data?.detailError && <><ErrorBox error={status.data.detailError} /><Button variant="outline" onClick={() => status.refetch()}>Check payment details again</Button></>}
      {failed && <p className="text-sm">This provider status alone does not establish that a replacement payment is safe. Review the existing operation before preparing another payment.</p>}
      {!payment.request && <p className="text-sm">Payment details are unavailable on this instance. The status below identifies this operation; it is not a complete payment receipt.</p>}
      {ownerActions.error && <QueryError error={ownerActions.error} retry={() => ownerActions.refetch()} />}
      {recovering && !final && <p role="status" className="text-sm">{recovering.stage === "submitted" ? "Submission attempted—checking the existing owner action’s outcome. Do not sign again." : "An owner action is already prepared. Review it or wait for its signing window to close before starting another."} <a href={app("/activity", `owner-${recovering.correlationId}`)} className="underline">Review the existing owner action in Payables</a></p>}
      {rejected && <p className="text-sm">Rejection submitted. The payment outcome is reported separately.</p>}
      {!heldEvidence && <p className="text-sm">Approval history is unverified. This payment status does not establish that it was held or approved here.</p>}
      {s && !isHeld && !final && <p role="status" className="text-sm">Outcome unresolved; <a href={app("/activity")} className="underline">review the existing operation in Payables Activity</a>. Do not create a replacement.</p>}
      {action.label && <p className="text-sm text-muted-foreground">{action.label}</p>}
      {isHeld && (
          <div className="flex flex-col gap-2 text-sm ">
            {dao && (proposal || approval) && <a className="underline" target="_blank" rel="noopener noreferrer" href={`https://trezu.app/${dao}/requests${proposal ? `/${proposal.id}` : ""}`}>Review and vote in Trezu</a>}
            {windowLeft !== null && !expired && (
              <span className="font-mono text-brand-strong tabular-nums">Signing window {minutesSeconds(windowLeft)} left</span>
            )}
            {expired && !action.busy && <span className="text-warning-muted-foreground">The last approval's signing window closed before it was used. File it again.</span>}
            {approvable && payment.approvalId && (
              <div className="flex flex-wrap items-center gap-2 ">
                {!canSign && <span className="text-muted-foreground">Only an account that can sign for the owner can approve or reject.</span>}
                <p>Approval releases this held payout for processing. It does not prove payment completed. A held payout does not block new sends.</p>
                <p>{dao ? "The payout deadline and the shorter owner-signature window are separate. A proposal and your vote do not prove the DAO threshold passed." : "Your wallet signs the approval directly."}</p>
                <ConfirmButton path="owner/prepare" disabled={!canSign} label={dao ? "Propose rejection" : "Sign rejection"} title="Reject this held payout?" description={`Reject ${what}. Rejection releases no payment.`} confirm={dao ? "Continue to DAO rejection" : "Continue to wallet"} onConfirm={() => decide("reject")} />
                <ConfirmButton path="owner/prepare" disabled={!canSign || !payment.request || Boolean(status.data?.detailError) || !agreements}
                  label={dao ? viewer?.access?.canPropose && viewer.access.canVote ? "File proposal and vote" : "File approval proposal" : "Sign approval"}
                  title="Approve this held payout?" description={`${what}. This approval releases the payout for processing; follow its payment status separately.`}
                  confirm={dao ? "Continue to proposal" : "Continue to wallet"} onConfirm={() => decide("approve")} />
              </div>
            )}
            <ErrorBox error={action.error} />
          </div>
      )}
      <Details summary="Payment history and public visibility" open={historyOpen}>
      <div className="hidden grid-cols-[1fr_2.5rem_1fr] gap-x-2 text-sm text-muted-foreground md:grid">
        <p className="text-right"><span className="block font-heading text-base font-medium text-foreground">What members see</span>Signed in to this dashboard</p>
        <span />
        <p><span className="block font-heading text-base font-medium text-foreground">What anyone on chain sees</span>No amount, payee or invoice, in what we've checked</p>
      </div>
      <ol>
        <Moment status={payment.at ? "complete" : "unverified"} when={time(payment.at)} title="Payment requested"
          detail={payment.request ? `${what}${payment.at ? `, recorded ${new Date(payment.at).toLocaleString()}` : ""}.` : "Original request details are unavailable on this instance."}
          outsider={{ text: "This view does not establish whether the original request has a public record." }} />
        <Moment status={step(1)} when={time(status.data?.createdAt)} title="Held for the owner's approval"
          detail={heldEvidence ? "An approval is recorded for this payout. Follow its current payment outcome separately." : "No held-payout evidence was recovered."}
          outsider={{ text: "No transaction: the provider holds the payment until it's approved." }}>
          {status.isPending && <Spinner />}
        </Moment>
        <Moment status={step(2)} when={time(proposal?.submittedAt)}
          title={dao ? "Proposal filed and voted" : rejected ? "Rejected by the owner's wallet" : approved ? "Approved by the owner's wallet" : "Owner wallet decision"}
          detail={proposal
            ? `Proposal #${proposal.id}: ${VOTE_WORDS[proposal.status] ?? proposal.status}, ${Object.keys(proposal.votes).length} vote${Object.keys(proposal.votes).length === 1 ? "" : "s"} so far.`
            : approved || rejected ? `The owner’s ${rejected ? "rejection" : "approval"} succeeded. The payment outcome is shown separately.`
              : approval && !expired ? "Prepared; waiting for a recorded vote." : "No proposal or wallet decision evidence was recovered."}
          outsider={dao
            ? proposal
              ? { text: `Proposal #${proposal.id} on ${dao}, worded "Approve the pending confidential request", naming the agent and this hash.`, value: approval?.hash }
              : { text: "No proposal was recovered by this view." }
            : { text: "No proposal: the owner's wallet signs a message, off chain." }}>

        </Moment>
        <Moment status={step(3)} when={null}
          title={rejected ? `Rejected by ${signer}` : "Approval signed and submitted"}
          detail={approved ? "The signature was checked against this approval's hash and sent to the provider." : rejected ? "The rejection was signed and submitted. Follow the payment outcome separately." : undefined}
          outsider={dao ? { text: "The MPC signature for that hash, returned by v1.signer." } : { text: "Unverified: whether anything public records the wallet's signature isn't checked here." }}>
          <span className="text-sm text-muted-foreground">Following the existing submission; do not sign again.</span>
        </Moment>
        <Moment status={step(4)} when={time(status.data?.updatedAt)} last
          title={failed ? `Provider reported ${s?.toLowerCase()}` : paid ? "Payment completed" : "Payment outcome"}
          detail={paid ? "The provider reports that this payment completed." : failed ? `The provider ended it as ${s?.toLowerCase()}${status.data?.failureCode && status.data.failureCode.toLowerCase() !== s?.toLowerCase() ? `: ${refusalText(status.data.failureCode)}` : ""}.` : undefined}
          outsider={{ text: "No public transfer was observed on the payout account in the documented 2026-10-11 run. This view does not independently verify public visibility for this payment." }}>
          <span className="text-sm text-muted-foreground">Waiting for a confirmed payment outcome. Review Activity before creating a replacement.</span>
        </Moment>
      </ol>
      </Details>
      <Details summary="Provider evidence">
        <PaymentEvidence evidence={status.data?.evidence} loading={status.isPending} readFailed={status.isError} />
      </Details>
      <Details summary="Payment reference">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Operation</span>
          <span className="break-all font-mono text-xs">{id}</span>
          <CopyButton text={id} />
        </div>
        {approval && <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Approval hash</span>
          <span className="break-all font-mono text-xs">{approval.hash}</span>
          <CopyButton text={approval.hash} />
        </div>}
      </Details>
      <a href={app(`/follow/payment?payment=${encodeURIComponent(id)}`)} className="self-start text-sm underline">Open this payment in Payables</a>
    </Card>
  );
}

/** Compact discovery or one selected payment. Missing history never hides a saved payment link. */
export function Payments({ title = "Payments", historyOpen = false, compact = false, selection }: {
  title?: string; historyOpen?: boolean; compact?: boolean; selection?: { payment?: string; invoice?: string };
}) {
  const app = useAppHref("payables");
  const { data } = useAgent();
  const canReadInvoices = useCanCall("invoices");
  const { list, held, pending, activity, history, ownerActions, invoices, invoiceRecords, invoicesEnabled } = usePayments(5_000);
  const [view, setView] = useState<"review" | "all">("review");
  const [query, setQuery] = useState("");
  const filterId = useId();
  const search: { payment?: string; invoice?: string } = selection ?? {};
  const invoice = invoiceRecords.find(invoice => search.invoice ? invoice.id === search.invoice : invoice.operation.correlationId === search.payment);
  const mismatched = Boolean(search.invoice && search.payment && invoice && invoice.operation.correlationId !== search.payment);
  // A local invoice/key never becomes a provider reference. Wait for an explicit recorded link.
  const selected = search.invoice ? mismatched ? undefined : invoice?.operation.correlationId : search.payment;
  if (selected && !list.some(([id]) => id === selected)) list.unshift([selected, { at: "" }]);
  const agreementQuery = useQuery(queries.agreements);
  // Newest first, as agreements/list answers and `termsInForce` reads it.
  const agreements = agreementQuery.isSuccess ? agreementQuery.data : undefined;
  const heldIds = new Set((held.data ?? []).map((h) => h.correlationId));
  const showQueue = compact || (!search.payment && !search.invoice);
  const shown = showQueue ? [] : list.filter(([id]) => id === selected);
  const queue = buildPaymentQueue({ payments: list, invoices: invoiceRecords, activity: activity.data, heldIds,
    pendingIds: new Set((pending.data ?? []).flatMap(action => action.state === "waiting" && action.payment ? [action.payment.correlationId] : [])),
    ownerActions: ownerActions.data });
  const reviewCount = queue.filter(record => record.needsReview).length;
  const visibleQueue = filterPaymentQueue(queue, view, query);
  const sources = [held, pending, history, ownerActions, activity, agreementQuery];
  const checking = sources.some(source => source.isPending) || (invoicesEnabled && invoices.isPending);
  const initialRead = checking && queue.length === 0;
  const complete = sources.every(source => source.isSuccess) && history.data?.complete && (!invoicesEnabled || invoices.isSuccess);
  const needsReview = invoiceRecords.filter(invoice => invoice.review).length;
  const denied = [held, pending, activity, history, ownerActions, agreementQuery].find(query => accessDenied(query.error));
  if (denied?.error) return <Section title={title}><QueryError error={denied.error} retry={() => denied.refetch()} /></Section>;
  return (
    <><Section
      title={title}
      description={showQueue ? "Review held payouts, invoice changes and unconfirmed outcomes. Open a record to check its current status." : "Owner approval and payment completion are separate. Missing evidence remains unverified."}
    >
      {showQueue && <>
        <FieldGroup className="sm:flex-row sm:items-end">
          <FieldPrimitive className="sm:w-auto sm:shrink-0">
            <FieldLabel id={filterId}>Show payments</FieldLabel>
            <ToggleGroup type="single" variant="outline" value={view} aria-labelledby={filterId} className="max-w-full flex-wrap"
              onValueChange={value => { if (value === "review" || value === "all") setView(value); }}>
              <ToggleGroupItem value="review" className="h-auto max-w-full whitespace-normal py-3">Needs review{!initialRead && ` (${reviewCount})`}</ToggleGroupItem>
              <ToggleGroupItem value="all" className="h-auto max-w-full whitespace-normal py-3">All records{!initialRead && ` (${queue.length})`}</ToggleGroupItem>
            </ToggleGroup>
          </FieldPrimitive>
          <Field label="Search recipient or reference" type="search" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
        </FieldGroup>
      </>}
      {kindOf(data) === "facilitator" && <div className="flex flex-col gap-2 text-sm">
        {!canReadInvoices && <p>Your account cannot read invoice records on this instance.</p>}
        {invoicesEnabled && invoices.isPending && (!showQueue || !initialRead) && <Loading label="Loading invoice records…" />}
        {invoicesEnabled && invoices.error && <ReadFailure label="Invoice records" error={invoices.error} retry={() => invoices.refetch()} retained={invoices.data !== undefined} updatedAt={invoices.dataUpdatedAt} />}
        {invoicesEnabled && invoices.isSuccess && !invoiceRecords.length && !showQueue && <p className="text-muted-foreground">No invoices are recorded on this instance. Held payouts may originate on another executor.</p>}
        {needsReview > 0 && showQueue && <p className="text-warning-muted-foreground">{needsReview} invoice{needsReview === 1 ? " has" : "s have"} changes needing review. Original payments are unchanged.</p>}
      </div>}
      {history.error && <QueryError error={history.error} retry={() => history.refetch()} />}
      {ownerActions.error && <QueryError error={ownerActions.error} retry={() => ownerActions.refetch()} />}
      {history.data && !history.data.complete && <p className="text-sm">Recent payment history is incomplete. Use a saved payment link to review older records.</p>}
      {held.error && <QueryError error={held.error} retry={() => held.refetch()} />}
      {pending.error && <QueryError error={pending.error} retry={() => pending.refetch()} />}
      {activity.error && <QueryError error={activity.error} retry={() => activity.refetch()} />}
      {agreementQuery.error && <QueryError error={agreementQuery.error} retry={() => agreementQuery.refetch()} />}
      {checking && (showQueue && initialRead ? <LoadingRecords label="Checking payments and owner actions…" /> : <Loading label="Checking payments and owner actions…" />)}
      {showQueue && !initialRead && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Showing {visibleQueue.length} of {queue.length} retained records{!complete ? " · checks incomplete" : ""}.</p>}
      {showQueue && !checking && !visibleQueue.length && <Empty className="items-start py-4"><EmptyContent className="items-start text-left">
        {query.trim() ? <><p>No matching records.</p><p className="text-muted-foreground">Try another recipient or reference, or search All records. Source warnings still apply.</p><Button variant="outline" onClick={() => setQuery("")}>Clear search</Button></>
          : complete && !queue.length ? <><p>No payment records found in the sources checked.</p><a href={app("/payees")} className="inline-flex min-h-11 items-center underline">Review Agreements in Payables</a></>
          : complete ? <><p>No records need review.</p><p className="text-muted-foreground">No open items were found in the retained records checked.</p><Button variant="outline" onClick={() => setView("all")}>View all records</Button></>
          : <><p>The available records show no matching items. Some checks are incomplete; review the notices above.</p><Button variant="outline" onClick={() => { for (const source of sources) void source.refetch(); if (invoicesEnabled) void invoices.refetch(); }}>Check records again</Button></>}
      </EmptyContent></Empty>}
      {showQueue && <ul className="divide-y" aria-label="Payment records">
        {visibleQueue.map(({ id, at, payment, invoice, needsReview, reason }) => {
          const owner = id ? paymentOwnerState(ownerActions.data ?? [], id) : undefined;
          const heldAtLastCheck = Boolean(id && heldIds.has(id));
          const label = owner?.recovering ? `Owner action ${owner.recovering.stage}` : owner?.approved ? "Approval recorded" : owner?.rejected ? "Rejection recorded" : heldAtLastCheck ? "Held at last check" : invoice ? invoiceStatus(invoice) : "Recorded payment";
          return <li key={id ? `payment-${id}` : `invoice-${invoice!.id}`}>
            <a href={app(`/follow/payment?${id ? `payment=${encodeURIComponent(id)}` : `invoice=${invoice!.id}`}`)} className="flex min-h-11 flex-col items-start gap-3 rounded-lg px-2 py-4 hover:bg-muted sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 w-full break-words sm:flex-1">
                <span className="block font-medium">{payment?.request ? exactPayment(payment.request, data.book) : invoice ? `${fromUnits(invoice.amount, 6)} USDC to ${invoice.payee}` : "Review retained payment details"}</span>
                <span className="block text-xs text-muted-foreground">{invoice ? "Invoice" : "Reference"} {short(invoice?.id ?? id!)}</span>
                <span className="text-sm text-muted-foreground">{at ? `Recorded ${ago(at)}` : "Recorded time unavailable"}</span>
              </span>
              <span className="flex min-w-0 max-w-full flex-col items-start gap-2 sm:items-end">
                <span className="flex max-w-full flex-wrap gap-2 [&>span]:h-auto [&>span]:min-h-6 [&>span]:max-w-full [&>span]:whitespace-normal [&>span]:py-1"><Badge tone={needsReview ? "warning" : "neutral"}>{label}</Badge>{invoice?.review && <Badge tone="warning">Invoice changes need review</Badge>}</span>
                {reason && !invoice?.review && !heldAtLastCheck && !owner?.recovering && <span className="text-sm text-muted-foreground">{reason}</span>}
                <span className="text-sm underline">{id ? "Review payment" : "Review invoice"}</span>
              </span>
            </a>
          </li>;
        })}
      </ul>}
      {!showQueue && search.invoice && invoicesEnabled && invoices.isSuccess && !invoice && <p className="text-sm">This invoice is not recorded on this instance. Check the executor retaining its records; no payment reference is assumed.</p>}
      {!showQueue && mismatched && <p role="alert" className="text-sm">The invoice and payment references do not match. Open the invoice from Payments to review its recorded payment.</p>}
      {!showQueue && invoice && !mismatched && <InvoiceReview invoice={invoice} readFailed={Boolean(invoices.error)} />}
      {shown.map(([id, payment]) => <PaymentCard key={id} id={id} payment={payment} agreements={agreements} historyOpen={historyOpen} />)}
    </Section>{showQueue && <WorkOrders payments />}</>
  );
}
