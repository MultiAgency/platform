import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { join } from "node:path";
import { agentId } from "./env.js";
import { getInvoice, invoiceId, listInvoices, type InvoiceInput } from "./invoice-store.js";
import { validate } from "./invoices.js";
import { appendSynced } from "./synced.js";
import { readRecordLines } from "./record-lines.js";

/**
 * Agreements with terms, `.agreements/<agent id>.jsonl`, append-only like the inbox. Either side
 * starts one: a payee the owner doesn't pay yet *requests* it from the invoice page (a contractor, a
 * new payee), or the owner *offers* it (a purchase order, a bounty or grant award). Neither is a
 * payment. The owner agrees by adding the payee to the policy; the payee then files an invoice;
 * nothing is paid because a vote passed.
 *
 * Terms are an amount ceiling per invoice and a deadline. The policy only knows the payee, so the
 * terms are this server's, shown to voters beside each held payout; the vote on every payment is
 * what enforces them.
 */

export type Terms = { maxAmount: string; until: string };
/** `payee`: asked for on the invoice page; `owner`: offered from the dashboard. */
export type Origin = "payee" | "owner";
/**
 * `requested`: a payee's request waits for the owner; `proposed`: terms are set and the agreement is
 * filed, not yet in force; `agreed`: the policy lists the payee, no invoice filed under it yet.
 */
export type AgreementStatus = "requested" | "proposed" | "agreed" | "filed" | "declined";
export type Agreement = { id: string; at: string; origin: Origin; payee: string; amount: string; note: string;
  submission?: string; terms?: Terms; status: AgreementStatus };

type Stored = Omit<Agreement, "status" | "terms">;
type Line = { agreement: Stored } | { decline: string } | { terms: Terms; for: string };
type Entry = Stored & { declined?: true; terms?: Terms };
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const amount = z.string().regex(/^\d+$/);
const storedAgreement = z.object({ id: z.string().min(1), at: timestamp, origin: z.enum(["payee", "owner"]),
  payee: z.string().min(1), amount, note: z.string(), submission: z.string().optional() });
const terms = z.object({ maxAmount: amount, until: timestamp });
const storedLine = z.union([
  z.object({ agreement: storedAgreement }),
  z.object({ decline: z.string().min(1) }),
  z.object({ for: z.string().min(1), terms }),
]);
const agreementList = z.object({ agreements: z.array(storedAgreement.extend({ terms: terms.optional(),
  status: z.enum(["requested", "proposed", "agreed", "filed", "declined"]) })) });
const offerResponse = z.object({ id: z.string().refine(value => value.trim().length > 0) });
const acknowledged = z.object({ ok: z.literal(true) });
const errorResponse = z.object({ error: z.string().min(1) });

/** Open requests kept at once: per account, and in all. Past either, a new one is turned away. */
const PER_ACCOUNT = 3;
const OPEN = 50;
/** A request unanswered this long stays listed but stops holding a slot, so stale ones can't block intake. */
const SLOT_DAYS = 14;

const file = () => {
  mkdirSync(".agreements", { recursive: true });
  return join(".agreements", `${agentId()}.jsonl`);
};

function read() {
  const path = file();
  const entries = new Map<string, Entry>();
  if (!existsSync(path)) return entries;
  for (const line of readRecordLines(path, storedLine)) {
    if ("decline" in line) {
      const entry = entries.get(line.decline);
      if (entry) entry.declined = true;
    } else if ("for" in line) {
      const entry = entries.get(line.for);
      if (entry) entry.terms = line.terms;
    } else entries.set(line.agreement.id, line.agreement);
  }
  return entries;
}

/** Filed: a request's own invoice (same submission), or for an offer any invoice the payee filed after it. */
const filed = (entry: Entry) =>
  entry.submission ? Boolean(getInvoice(entry.id)) : listInvoices(entry.payee).some((invoice) => invoice.at >= entry.at);

const statusOf = (entry: Entry, agreed: Set<string>): AgreementStatus =>
  entry.declined ? "declined"
    : filed(entry) ? "filed"
      : agreed.has(entry.payee) ? "agreed"
        : entry.terms ? "proposed" : "requested";

/** Every agreement, newest first, with where it stands against the policy's agreed payees. */
export function agreements(agreed: Set<string>): Agreement[] {
  return [...read().values()].reverse().map(({ declined, ...entry }) => ({ ...entry, status: statusOf({ ...entry, declined }, agreed) }));
}

/** A payee's request, recorded once per submission; `busy` when too many are already open. */
export function requestAgreement(input: InvoiceInput, agreed: Set<string>): { id: string; status: AgreementStatus | "busy" } {
  const id = invoiceId(input);
  const all = agreements(agreed);
  const known = all.find((a) => a.id === id);
  if (known) return { id, status: known.status };
  const since = Date.now() - SLOT_DAYS * 86_400_000;
  const open = all.filter((a) => a.origin === "payee" && (a.status === "requested" || a.status === "proposed") && Date.parse(a.at) >= since);
  if (open.length >= OPEN || open.filter((a) => a.payee === input.payee).length >= PER_ACCOUNT) return { id, status: "busy" };
  appendSynced(file(), { agreement: { ...input, id, origin: "payee", at: new Date().toISOString() } } satisfies Line);
  return { id, status: "requested" };
}

/** Sets the terms of a payee's request, when the owner proposes agreeing to it. */
export function proposeTerms(id: string, until: Date) {
  const entry = read().get(id);
  if (!entry) throw new Error("No such agreement");
  if (entry.declined) throw new Error("This agreement was declined");
  appendSynced(file(), { for: id, terms: { maxAmount: entry.amount, until: until.toISOString() } } satisfies Line);
}

/** The owner's offer: an account, an amount ceiling, what it's for and until when. */
export function offerTerms(offer: { payee: string; amount: string; note: string; until: Date }) {
  const id = randomUUID().replaceAll("-", "");
  const { until, ...rest } = offer;
  appendSynced(file(), { agreement: { ...rest, id, origin: "owner", at: new Date().toISOString() } } satisfies Line);
  appendSynced(file(), { for: id, terms: { maxAmount: offer.amount, until: until.toISOString() } } satisfies Line);
  return id;
}

export function declineAgreement(id: string) {
  if (!read().has(id)) throw new Error("No such agreement");
  appendSynced(file(), { decline: id } satisfies Line);
}

/** The terms of a payee's newest agreement that has terms and isn't declined, if any: what a held payout to them is checked against. */
export function termsFor(payee: string): Terms | undefined {
  return [...read().values()].filter((e) => e.payee === payee && e.terms && !e.declined).at(-1)?.terms;
}

/** Whether a payment is within the terms: at most the agreed amount, before the deadline. */
export const withinTerms = (terms: Terms, amount: string, at: Date) =>
  BigInt(amount) <= BigInt(terms.maxAmount) && at.getTime() <= Date.parse(terms.until);

/**
 * Where an agent server finds its agreements. The executor that serves the invoice page holds them;
 * an approve-only instance of the same agent (the hosted dashboard) reads and writes them on that
 * host, through its internal endpoint and a shared secret (`AGREEMENTS_URL`, `AGREEMENTS_SECRET`).
 */
export type AgreementStore = {
  list(): Promise<Agreement[]>;
  propose(id: string, until: Date): Promise<void>;
  /** `amount` in USDC as typed ("250.5"); stored in raw units once checked. */
  offer(offer: { payee: string; amount: string; note: string; until: Date }): Promise<string>;
  decline(id: string): Promise<void>;
};

const future = (until: Date) => {
  if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) throw new Error("The deadline must be in the future.");
  return until;
};

export function localStore(agreed: () => Promise<Set<string>>): AgreementStore {
  return {
    list: async () => agreements(await agreed()),
    propose: async (id, until) => proposeTerms(id, future(until)),
    offer: async (offer) => {
      // Checked where it is stored, whichever instance asked: a NEAR account and a USDC amount.
      const valid = validate({ ...offer, submission: randomUUID() });
      if ("invalid" in valid) throw new Error(`Check the ${valid.invalid}.`);
      return offerTerms({ payee: valid.payee, amount: valid.amount, note: valid.note, until: future(offer.until) });
    },
    decline: async (id) => declineAgreement(id),
  };
}

export function remoteStore(url: string, secret: string): AgreementStore {
  const call = async <T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> => {
    const res = await fetch(new URL(`/internal/agreements${path}`, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A hung invoice host fails this call, not the dashboard waiting on it.
      signal: AbortSignal.timeout(10_000),
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const error = errorResponse.safeParse(json);
      throw new Error(error.success ? error.data.error : `The invoice host answered ${res.status}`);
    }
    const result = schema.safeParse(json);
    // A mutation may already have been applied. Report the missing acknowledgment; never retry it.
    if (!result.success) throw new Error("The invoice host returned an invalid response. The result could not be confirmed.");
    return result.data;
  };
  return {
    list: async () => (await call("", agreementList)).agreements,
    propose: async (id, until) => void (await call("/propose", acknowledged, { id, until: until.toISOString() })),
    offer: async (offer) => (await call("/offer", offerResponse, { ...offer, until: offer.until.toISOString() })).id,
    decline: async (id) => void (await call("/decline", acknowledged, { id })),
  };
}
