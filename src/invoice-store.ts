import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Line, Op } from "./ops.js";
import { isTerminal, isUnknownOutcome } from "./operation-status.js";
import { PublicError } from "./public-error.js";

/** One authoritative store for invoice identity, revisions, payment attempts and reservations.
 * All writes are local transactions; none assert exactly-once effects at the remote provider.
 * Other (non-invoice) operations retain their existing JSONL store for this migration. */
export type InvoiceInput = { payee: string; submission: string; amount: string; note: string };
export type PaymentState = "PREPARED" | "SUBMISSION_ATTEMPTED" | "OBSERVED" | "UNKNOWN" | "RESOLVED";
type PaymentRow = { key: string; invoice_id: string; request: string; context: string; state: PaymentState; status: string | null;
  correlation_id: string | null; refused: string | null; at: string };
export type StoredInvoice = InvoiceInput & { id: string; at: string; revision: number; operation: Op; reservation: string; review: boolean;
  revisions: { revision: number; amount: string; note: string; review: number }[] };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const invoiceId = <T extends Pick<InvoiceInput, "payee" | "submission">>(invoice: T) =>
  hash(JSON.stringify([invoice.payee, invoice.submission])).slice(0, 32);
const content = (invoice: InvoiceInput) => JSON.stringify([invoice.amount, invoice.note]);

export function invoiceDatabasePath() {
  const id = process.env.AGENT_ID;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("A valid AGENT_ID is required for invoice storage");
  return join(".invoices", `${id}.sqlite`);
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function database<T>(run: (db: DatabaseSync) => T): T {
  const path = invoiceDatabasePath();
  const marker = `${path}.initialized`;
  if (!existsSync(path) && existsSync(marker)) throw new Error("Invoice database is missing; restore it before executing payments");
  mkdirSync(".invoices", { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    if (Number(db.prepare("PRAGMA user_version").get()!.user_version) > 1)
      throw new Error("Invoice schema is newer than this build; restore with a compatible application");
    chmodSync(path, 0o600);
    db.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, payee TEXT NOT NULL, submission TEXT NOT NULL,
        at TEXT NOT NULL, UNIQUE(payee, submission));
      CREATE TABLE IF NOT EXISTS revisions (invoice_id TEXT NOT NULL REFERENCES invoices(id), revision INTEGER NOT NULL,
        amount TEXT NOT NULL, note TEXT NOT NULL, content_hash TEXT NOT NULL, review INTEGER NOT NULL,
        PRIMARY KEY(invoice_id, revision), UNIQUE(invoice_id, content_hash));
      CREATE TABLE IF NOT EXISTS payments (key TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
        revision INTEGER NOT NULL DEFAULT 1, attempt INTEGER NOT NULL DEFAULT 1, request TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, status TEXT, correlation_id TEXT UNIQUE,
        refused TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (payment_key TEXT PRIMARY KEY REFERENCES payments(key),
        asset TEXT NOT NULL, amount TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports (path TEXT PRIMARY KEY, digest TEXT NOT NULL);`);
    db.exec("PRAGMA user_version = 1");
    // Preserve filed history and identity without inventing missing operation links. Each legacy
    // file is imported, then moved aside, so an old writer still running (a deploy overlapping the
    // previous one) can only start a new file, which is imported in turn: it never changes what was
    // imported, and never stops this store. Its ids stay blocked from filing again (prepareInvoice).
    for (const dir of [".invoices", ".intake"]) {
      const source = join(dir, `${process.env.AGENT_ID}.jsonl`);
      if (!existsSync(source)) continue;
      const raw = readFileSync(source, "utf8");
      transaction(db, () => {
        for (const line of raw.split("\n").filter(Boolean)) {
          const entry = JSON.parse(line) as { id: string; at: string };
          if (!entry.id || !entry.at) throw new Error("Invalid legacy invoice record; migration requires review");
          const old = db.prepare("SELECT entry FROM legacy WHERE id = ?").get(entry.id) as { entry: string } | undefined;
          const firstAt = old ? (JSON.parse(old.entry) as { at: string }).at : entry.at;
          db.prepare("INSERT OR REPLACE INTO legacy VALUES (?, ?)").run(entry.id, JSON.stringify({ ...entry, at: firstAt }));
        }
        db.prepare("INSERT OR REPLACE INTO imports VALUES (?, ?)").run(source, hash(raw));
      });
      mkdirSync(join(".invoices", "legacy"), { recursive: true, mode: 0o700 });
      renameSync(source, join(".invoices", "legacy", `${dir.slice(1)}-${process.env.AGENT_ID}-${Date.now()}.jsonl`));
    }
    // A lost database must not silently become an empty book on the next startup.
    if (!existsSync(marker)) writeFileSync(marker, "Restore the database; do not delete this marker to bypass recovery.\n", { mode: 0o600 });
    return run(db);
  } finally { db.close(); }
}

const asOp = (row: PaymentRow): Op => ({
  ...JSON.parse(row.context), at: row.at, idempotencyKey: row.key, kind: "invoices", method: "transfer",
  request: JSON.parse(row.request), invoiceId: row.invoice_id, submissionState: row.state,
  status: row.status ?? (row.state === "PREPARED" ? "PREPARED" : "UNKNOWN"),
  ...(row.correlation_id && { correlationId: row.correlation_id }), ...(row.refused && { refused: row.refused }),
});

function get(db: DatabaseSync, id: string): StoredInvoice | undefined {
  const invoice = db.prepare(`SELECT i.*, r.amount, r.note, r.revision FROM invoices i
    JOIN revisions r ON r.invoice_id = i.id AND r.revision = 1 WHERE i.id = ?`).get(id) as
    (InvoiceInput & { id: string; at: string; revision: number }) | undefined;
  if (!invoice) return;
  const payment = db.prepare("SELECT * FROM payments WHERE invoice_id = ?").get(id) as PaymentRow;
  const reserve = db.prepare("SELECT amount, released FROM reservations WHERE payment_key = ?").get(payment.key) as { amount: string; released: number };
  const review = db.prepare("SELECT 1 FROM revisions WHERE invoice_id = ? AND review = 1").get(id) !== undefined;
  const revisions = db.prepare("SELECT revision, amount, note, review FROM revisions WHERE invoice_id = ? ORDER BY revision").all(id) as StoredInvoice["revisions"];
  return { ...invoice, operation: asOp(payment), reservation: reserve.released ? "0" : reserve.amount, review, revisions };
}

export const getInvoice = (id: string) => database((db) => get(db, id));
export const listInvoices = (payee?: string) => database((db) =>
  (db.prepare(`SELECT id FROM invoices ${payee ? "WHERE payee = ?" : ""} ORDER BY at DESC`).all(...(payee ? [payee] : [])) as { id: string }[])
    .map(({ id }) => get(db, id)!));

/** The initial revision, stable attempt/key, exact request and reservation commit together. */
export function prepareInvoice(invoice: InvoiceInput, asset: string): StoredInvoice {
  return database((db) => transaction(db, () => {
    const id = invoiceId(invoice);
    const known = get(db, id);
    if (known) return known;
    if (db.prepare("SELECT 1 FROM legacy WHERE id = ?").get(id)) throw new Error("This invoice exists in legacy history; review it before creating another payment");
    const at = new Date().toISOString();
    const key = `invoices:${randomUUID()}`;
    db.prepare("INSERT INTO invoices VALUES (?, ?, ?, ?)").run(id, invoice.payee, invoice.submission, at);
    db.prepare("INSERT INTO revisions VALUES (?, 1, ?, ?, ?, 0)").run(id, invoice.amount, invoice.note, hash(content(invoice)));
    const request = JSON.stringify({ asset, amount: invoice.amount, recipient: invoice.payee, confidential: true });
    db.prepare("INSERT INTO payments (key, invoice_id, request, state, at) VALUES (?, ?, ?, 'PREPARED', ?)").run(key, id, request, at);
    db.prepare("INSERT INTO reservations (payment_key, asset, amount) VALUES (?, ?, ?)").run(key, asset, invoice.amount);
    return get(db, id)!;
  }));
}

/** Revised content is retained for review, never substituted into an authorized/in-flight payment. */
export function noteRevision(invoice: InvoiceInput): StoredInvoice {
  return database((db) => transaction(db, () => {
    const id = invoiceId(invoice);
    const known = get(db, id);
    if (!known) throw new Error("Unknown invoice");
    const next = db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM revisions WHERE invoice_id = ?").get(id) as { n: number };
    db.prepare("INSERT OR IGNORE INTO revisions VALUES (?, ?, ?, ?, ?, 1)").run(id, next.n, invoice.amount, invoice.note, hash(content(invoice)));
    return get(db, id)!;
  }));
}

export function invoiceOperations(): Op[] {
  const path = invoiceDatabasePath();
  if (!existsSync(path) && !existsSync(`${path}.initialized`) && !existsSync(join(".invoices", `${process.env.AGENT_ID}.jsonl`))) return [];
  return database((db) => (db.prepare("SELECT * FROM payments ORDER BY at").all() as PaymentRow[]).map(asOp));
}

/** Called at the lowest local send boundary. A persistent compare-and-set prevents resubmission. */
export function claimInvoiceSubmission(key: string, request: unknown): boolean {
  if (!invoiceOperations().some((op) => op.idempotencyKey === key)) return false;
  return database((db) => transaction(db, () => {
    const row = db.prepare("SELECT * FROM payments WHERE key = ?").get(key) as PaymentRow;
    if (JSON.stringify(request) !== row.request) throw new Error("Invoice payment body changed");
    if (row.state !== "PREPARED") throw new Error("Invoice submission already attempted; replay is blocked");
    if (get(db, row.invoice_id)!.review) throw new Error("Invoice revision requires review");
    db.prepare("UPDATE payments SET state = 'SUBMISSION_ATTEMPTED', status = 'UNKNOWN' WHERE key = ?").run(key);
    return true;
  }));
}

/** Return true when this line belongs to SQLite; it must never also be written to JSONL. */
export function recordInvoiceOperation(line: Line): boolean {
  if (!invoiceOperations().some((op) => op.idempotencyKey === line.idempotencyKey)) return false;
  database((db) => transaction(db, () => {
    const row = db.prepare("SELECT * FROM payments WHERE key = ?").get(line.idempotencyKey) as PaymentRow;
    if ("request" in line) {
      if (JSON.stringify(line.request) !== row.request) throw new Error("Invoice payment body changed");
      db.prepare("UPDATE payments SET context = ? WHERE key = ?").run(JSON.stringify({ policyRevision: line.policyRevision,
        policyDigest: line.policyDigest, usdIn: line.usdIn, planId: line.planId }), row.key);
      return;
    }
    if (row.state === "RESOLVED") return; // stale reads cannot reopen or rewrite terminal evidence
    if ("refused" in line) {
      if (!["PREPARED", "SUBMISSION_ATTEMPTED"].includes(row.state)) throw new Error("A later refusal cannot resolve an unknown invoice payment");
      db.prepare("UPDATE payments SET state = 'RESOLVED', refused = ? WHERE key = ?").run(line.refused, row.key);
      db.prepare("UPDATE reservations SET released = 1 WHERE payment_key = ?").run(row.key);
    } else if ("correlation_id" in line) {
      // As the journal reader requires of a versioned operation: no provider outcome before its submission claim.
      if (row.state === "PREPARED") throw new Error("Invoice outcome without submission claim; replay is blocked");
      if (row.correlation_id && row.correlation_id !== line.correlation_id) throw new Error("Invoice correlation id changed");
      const terminal = isTerminal(line.status);
      const unknown = isUnknownOutcome(line.status);
      db.prepare("UPDATE payments SET state = ?, status = ?, correlation_id = ? WHERE key = ?")
        .run(terminal ? "RESOLVED" : unknown ? "UNKNOWN" : "OBSERVED", line.status, line.correlation_id, row.key);
      if (terminal) db.prepare("UPDATE reservations SET released = 1 WHERE payment_key = ?").run(row.key);
    }
  }));
  return true;
}

export function markInvoiceUnknown(key: string) {
  database((db) => db.prepare("UPDATE payments SET state = 'UNKNOWN', status = 'UNKNOWN' WHERE key = ? AND state != 'RESOLVED' AND state != 'PREPARED'").run(key));
}

/** Local cancellation is possible only with durable proof that submission never began. */
export function cancelPreparedInvoice(id: string) {
  return database((db) => transaction(db, () => {
    const invoice = get(db, id);
    // A refused cancellation changes nothing; it does not show whether the payment was submitted.
    if (!invoice || invoice.operation.submissionState !== "PREPARED")
      throw new PublicError("Only a never-submitted invoice can be cancelled. This cancellation was refused and the invoice is unchanged; check its recorded status.");
    db.prepare("UPDATE payments SET state = 'RESOLVED', refused = 'invoice_cancelled_before_submission' WHERE key = ?").run(invoice.operation.idempotencyKey);
    db.prepare("UPDATE reservations SET released = 1 WHERE payment_key = ?").run(invoice.operation.idempotencyKey);
    return get(db, id)!;
  }));
}

/** Imported history is read-only: never infer a missing invoice/payment link or resend it. */
export const legacyInvoices = () => database((db) =>
  (db.prepare("SELECT entry FROM legacy").all() as { entry: string }[]).map(({ entry }) => JSON.parse(entry) as
    { id: string; payee?: string; amount?: string; note?: string; at: string; status?: string; correlationId?: string }));
