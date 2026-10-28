import { z } from "zod";
import { pay } from "../agent.js";
import { held, paymentHistory, paymentStatus } from "../payouts.js";
import { cancelPreparedInvoice, listInvoices } from "../invoice-store.js";
import { type AgreementStore, localStore, remoteStore } from "../agreements.js";
import { agreed } from "../invoices.js";
import { os } from "./base.js";
import { readOutput } from "./read-output.js";
import { transferAccount, units, reviewedPolicy, payoutRequestInput, payoutStatusInput } from "../contract/inputs.js";
import { payoutStatus, requestPayout } from "../payout-requests.js";

const agreementId = z.string().regex(/^[0-9a-f]{32}$/);
/** This host's agreements when it serves the invoice page; otherwise the invoice host's, if configured. */
function agreementStore(): AgreementStore {
  const { INVOICES_PORT, AGREEMENTS_URL, AGREEMENTS_SECRET } = process.env;
  return !INVOICES_PORT && AGREEMENTS_URL && AGREEMENTS_SECRET ? remoteStore(AGREEMENTS_URL, AGREEMENTS_SECRET) : localStore(agreed);
}

export const payablesRoutes = {
  pay: os
    .input(z.object({ recipient: transferAccount, asset: z.string(), amount: units, confidential: z.boolean(), expectedPolicy: reviewedPolicy }))
    .handler(({ input: { expectedPolicy, ...request } }) => pay(request, expectedPolicy)),
  /** Payouts under the caller's own `requestId` (payout-requests.ts): sent at most once, answered by `requestId`. */
  payouts: {
    request: os.input(payoutRequestInput).handler(({ input, context }) => requestPayout(context.actor, input)),
    status: os.use(readOutput("payouts/status")).input(payoutStatusInput).handler(({ input, context }) => payoutStatus(context.actor, input.requestId)),
  },
  /**
   * Agreements with terms (agreements.ts): requested by payees on the invoice page, or offered by the
   * owner. Proposing terms or offering only records them; agreeing is the owner's policy update.
   */
  agreements: {
    list: os.use(readOutput("agreements/list")).handler(() => agreementStore().list()),
    propose: os.input(z.object({ id: agreementId, until: z.iso.datetime() }))
      .handler(({ input }) => agreementStore().propose(input.id, new Date(input.until))),
    offer: os.input(z.object({ payee: transferAccount, amount: z.string(), note: z.string().max(200), until: z.iso.datetime() }))
      .handler(async ({ input }) => ({ id: await agreementStore().offer({ ...input, until: new Date(input.until) }) })),
    decline: os.input(z.object({ id: agreementId })).handler(({ input }) => agreementStore().decline(input.id)),
  },
  /** Operator review reads the same durable invoice records; it never initiates a second payout. */
  invoices: os.use(readOutput("invoices")).handler(() => listInvoices()),
  cancelPreparedInvoice: os.input(z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }))
    .handler(({ input }) => cancelPreparedInvoice(input.id)),
  /** Money actions waiting for the owner's approval. */
  held: os.use(readOutput("held")).handler(() => held({ complete: true })),
  /** One of this agent's payments as the provider sees it now (`paymentStatus` in src/payouts.ts). */
  // `waitMs`: long-poll at the provider, kept under proxies' and browsers' timeouts.
  paymentHistory: os.use(readOutput("paymentHistory")).handler(() => paymentHistory()),
  paymentStatus: os.input(z.object({ correlationId: z.string().min(1).max(200), waitMs: z.number().int().min(0).max(25_000).optional() })).use(readOutput("paymentStatus"))
    .handler(({ input }) => paymentStatus(input.correlationId, input.waitMs)),
};
