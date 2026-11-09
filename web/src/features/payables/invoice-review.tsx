import { isSettled } from "./payment-status";
import { useAgent } from "../../app/agent-context";
import { ConfirmButton } from "../owner/confirm-button";
import { ago, client, fromUnits, useAttempt } from "../../shared/lib";
import { useCanCall } from "../../app/viewer";
import { refusalText } from "../../shared/words";
import { Badge, Card, CopyButton, Details, ErrorBox, Section, statusTone } from "../../shared/ui";

export type InvoiceRecord = Awaited<ReturnType<typeof client.invoices>>[number];

export function invoiceStatus(invoice: InvoiceRecord) {
  if (invoice.operation.refused) return `refused · ${refusalText(invoice.operation.refused)}`;
  if (invoice.operation.submissionState === "PREPARED") return "Prepared, never submitted";
  return invoice.operation.status?.toLowerCase() ?? "outcome unknown";
}

/** One selected invoice's original terms, retained revisions and existing cancellation control. */
export function InvoiceReview({ invoice, readFailed = false }: { invoice: InvoiceRecord; readFailed?: boolean }) {
  const canReadInvoices = useCanCall("invoices");
  const { setup } = useAgent();
  const { error, attempt } = useAttempt();
  if (!canReadInvoices) return null;
  const prepared = invoice.operation.submissionState === "PREPARED";
  const unresolved = !prepared && !invoice.operation.refused && !isSettled(invoice.operation.status) && invoice.operation.status !== "PENDING_APPROVAL";
  return <Section title="Invoice details" description="Changed invoice details require review and never replace a payment already submitted.">
    <Card>
      <div className="flex min-w-0 flex-wrap justify-between gap-2">
        <span className="min-w-0 break-words">{invoice.payee} · {fromUnits(invoice.amount, 6)} USDC</span>
        <span className="min-w-0 max-w-full [&>span]:h-auto [&>span]:min-h-6 [&>span]:max-w-full [&>span]:whitespace-normal [&>span]:py-1">
          <Badge tone={invoice.operation.refused ? "warning" : statusTone(invoice.operation.status)}>{invoiceStatus(invoice)}</Badge>
        </span>
      </div>
      <p className="text-sm text-muted-foreground">Reserved: {fromUnits(invoice.reservation, 6)} USDC · Filed {ago(invoice.at)}</p>
      {invoice.note && <p className="break-words text-sm">{invoice.note}</p>}
      {invoice.review && <p className="text-sm text-warning-muted-foreground">Invoice changes need review; the original payment is unchanged.</p>}
      {prepared && <p className="text-sm">This invoice is prepared; nothing has been submitted.</p>}
      {unresolved && <p className="text-sm">The operation outcome is unresolved. Review the existing operation before creating a replacement payment.</p>}
      {!invoice.operation.correlationId && !prepared && !invoice.operation.refused && <p className="text-sm">No provider payment reference is recorded. The invoice identity does not establish a payment outcome.</p>}
      <Details summary={`Invoice revisions (${invoice.revisions.length})`} open={invoice.review || undefined}>
        {invoice.revisions.map((r) => <p key={r.revision} className="break-words text-sm">
          Revision {r.revision}: {fromUnits(r.amount, 6)} USDC{r.note ? ` · ${r.note}` : ""}{r.review ? " · Needs review; original payment unchanged" : ""}
        </p>)}
      </Details>
      <Details summary="Identifiers">
        <div className="flex flex-wrap items-center gap-2"><span className="break-all font-mono text-xs text-muted-foreground">Invoice {invoice.id}</span><CopyButton text={invoice.id} /></div>
        <div className="flex flex-wrap items-center gap-2"><span className="break-all font-mono text-xs text-muted-foreground">Operation key {invoice.operation.idempotencyKey}</span><CopyButton text={invoice.operation.idempotencyKey} /></div>
      </Details>
      {prepared && <div className="flex flex-col items-start gap-2">
          {setup.executor === false && <p className="text-sm">Cancellation is available on the executor; this instance is approve-only.</p>}
          <div><ConfirmButton
            path="cancelPreparedInvoice"
            disabled={setup.executor === false || readFailed} label="Cancel unsubmitted invoice" title="Cancel this unsubmitted invoice?"
            description="This payment has never been submitted. Its reservation will be released. Its identity and revisions will remain in the records."
            confirm="Cancel invoice" onConfirm={() => attempt(() => client.cancelPreparedInvoice({ id: invoice.id }))} /></div>
      </div>}
      <ErrorBox error={error} />
    </Card>
  </Section>;
}
