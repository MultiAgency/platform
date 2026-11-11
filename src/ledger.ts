import { Effect } from "effect";
import type { StatusResponse } from "@near-intents-agent-api/sdk";
import { z } from "zod";
import { agentId } from "./env.js";
import { api } from "./api.js";
import { FastnearFailure, decodeRead, fastnearPostEffect, indexedPages, runFastnear, transactionsEffect } from "./fastnear.js";
import { rawBalance } from "./holdings.js";
import { readOps } from "./ops.js";

/**
 * The agent's books, from three sources that each hold part of the story:
 * - the API's history: every execution, its status, amounts and settlement evidence, but no asset ids;
 * - the wallet provider's audit trail: the assets of each request, keyed by provider request id;
 * - this server's ops log: why each action was sent (kind, plan) and under which mandate.
 *
 * Reconciliation compares each balance with recorded flows. The public balance lives on
 * `intents.near`, where FastNear's Transfers API indexes every movement, so it must match to the unit.
 * The confidential balance lives on `intents.far`, which nothing public indexes: it is checked against
 * the API's own executions. Any residual is unexplained: outside credits, missing records or
 * observations taken at different times can all cause it. This is not independent custody proof.
 */

const MONEY = new Set(["deposit", "swap", "transfer", "shield", "unshield", "withdraw"]);

export type Row = {
  at: string;
  settledAt: string;
  type: string;
  status: string;
  failureCode: string | null;
  confidential: boolean;
  assetIn: string | null;
  amountIn: string | null;
  assetOut: string | null;
  amountOut: string | null;
  recipient: string | null;
  correlationId: string;
  intentHash: string | null;
  approvalId: string | null;
  /** Why this server sent it; null for actions it did not send (deposits, other clients). */
  kind: string | null;
  planId: string | null;
  policyRevision: number | null;
  policyDigest: string | null;
  usdIn: number | null;
};

type Details = Record<string, unknown> & { evidence?: Record<string, unknown> };
/** A provider request event. Confidential requests name `origin_asset`/`destination_asset`, public swaps `token_in`/`token_out`. */
type AuditEvent = {
  type: string;
  request_id?: string;
  origin_asset?: string;
  destination_asset?: string;
  token_in?: string;
  token_out?: string;
  amount_in?: string;
  recipient?: string;
};

const text = (value: unknown) => (typeof value === "string" ? value : null);
const field = (details: Details, key: string) => text(details[key]) ?? text(details.evidence?.[key]);

async function history(id: string) {
  const all: StatusResponse[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.getHistory(id, { cursor, limit: 100 });
    all.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return all.filter((e) => MONEY.has(e.type));
}

/** The provider's request events, by request id: what each request spent and bought. */
async function audit(id: string) {
  const byRequest = new Map<string, AuditEvent>();
  for (let offset = 0; ; offset += 100) {
    const { data } = await api.listProviderRecords(id, "audit", { limit: 100, offset });
    const events = (data as { events?: AuditEvent[] }).events ?? [];
    for (const e of events) {
      const origin = e.origin_asset ?? e.token_in;
      if (!e.request_id || !origin || byRequest.has(e.request_id)) continue;
      byRequest.set(e.request_id, { ...e, origin_asset: origin, destination_asset: e.destination_asset ?? e.token_out });
    }
    if (events.length < 100) return byRequest;
  }
}

const nonempty = z.string().refine(value => value.trim().length > 0);
const functionCall = z.object({ FunctionCall: z.object({ method_name: z.string(), args: z.string() }) });
const depositReceipt = z.object({
  receipt: z.object({ receiver_id: nonempty, receipt: z.object({ Action: z.object({ actions: z.array(z.unknown()) }).optional() }).optional() }),
  execution_outcome: z.object({ outcome: z.object({ logs: z.array(z.string()), status: z.unknown().optional() }) }),
});
const depositReceipts = z.object({ transactions: z.array(z.object({ receipts: z.array(depositReceipt) })) });
const eventEnvelope = z.object({ standard: nonempty, event: nonempty, data: z.unknown().optional() });
const transferData = z.array(z.object({ new_owner_id: nonempty })).min(1);
const transferArgs = z.object({ receiver_id: nonempty, amount: z.string().regex(/^\d+$/) });
/** An action receipt's actions apply together: a success status means each one ran. */
const succeeded = (status: unknown) => typeof status === "object" && status !== null && ("SuccessValue" in status || "SuccessReceiptId" in status);
/** `amount` is known only from an `ft_transfer` call; an event's transfer is matched by address alone. */
type DepositTransfer = { address: string; asset: string; amount?: string };
const unavailableDeposit = () => new FastnearFailure("DepositEvidence");

/**
 * Validate the whole response before using any transfer: a valid early match must not conceal
 * malformed evidence later in the transaction. Errors never include private receipt contents.
 */
function depositTransfers(response: unknown): DepositTransfer[] {
  const parsed = depositReceipts.safeParse(response);
  if (!parsed.success) throw unavailableDeposit();
  const transfers: DepositTransfer[] = [];
  for (const receipt of parsed.data.transactions.flatMap(t => t.receipts)) {
    // A token that logs no NEP-141 event (wrap.near) still shows its successful `ft_transfer` call. Not
    // `ft_transfer_call`: its receiver can hand the tokens back after this receipt succeeds.
    for (const action of receipt.receipt.receipt?.Action?.actions ?? []) {
      const call = functionCall.safeParse(action);
      if (!call.success || call.data.FunctionCall.method_name !== "ft_transfer") continue;
      let raw: unknown;
      try { raw = JSON.parse(Buffer.from(call.data.FunctionCall.args, "base64").toString("utf8")); } catch { throw unavailableDeposit(); }
      const args = transferArgs.safeParse(raw);
      if (!args.success) throw unavailableDeposit();
      if (succeeded(receipt.execution_outcome.outcome.status))
        transfers.push({ address: args.data.receiver_id, asset: `nep141:${receipt.receipt.receiver_id}`, amount: args.data.amount });
    }
    for (const log of receipt.execution_outcome.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let raw: unknown;
      try { raw = JSON.parse(log.slice("EVENT_JSON:".length)); } catch { throw unavailableDeposit(); }
      const event = eventEnvelope.safeParse(raw);
      if (!event.success) throw unavailableDeposit();
      if (event.data.standard !== "nep141" || event.data.event !== "ft_transfer") continue;
      const data = transferData.safeParse(event.data.data);
      if (!data.success) throw unavailableDeposit();
      for (const transfer of data.data) transfers.push({ address: transfer.new_owner_id, asset: `nep141:${receipt.receipt.receiver_id}` });
    }
  }
  return transfers;
}

/** One lookup per hash per ledger read; no persistent cache or assumed batch-response mapping. */
async function readDeposits(executions: StatusResponse[], signal?: AbortSignal) {
  const hashes = new Set<string>();
  for (const e of executions) {
    const details = (e.details ?? {}) as Details;
    const hash = field(details, "deposit_tx_hash");
    if (e.type === "deposit" && e.status === "SUCCESS" && hash && field(details, "deposit_address")) hashes.add(hash);
  }
  const entries = await runFastnear(Effect.forEach([...hashes], hash => Effect.gen(function* () {
    const response = yield* transactionsEffect("/transactions", { tx_hashes: [hash] });
    const transfers = yield* Effect.try({ try: () => depositTransfers(response), catch: () => unavailableDeposit() });
    return [hash, transfers] as const;
  }), { concurrency: 4 }), signal);
  return new Map(entries);
}

export async function ledger(id = agentId(), signal?: AbortSignal): Promise<Row[]> {
  const [executions, events] = await Promise.all([history(id), audit(id)]);
  const ops = new Map(readOps().flatMap((op) => (op.correlationId ? [[op.correlationId, op] as const] : [])));
  const deposits = await readDeposits(executions, signal);
  const rows: Row[] = [];
  for (const e of executions) {
    const details = (e.details ?? {}) as Details;
    const op = ops.get(e.correlation_id);
    const request = (op?.request ?? {}) as Record<string, unknown>;
    const event = events.get(field(details, "provider_request_id") ?? "");
    let assetIn = event?.origin_asset ?? text(request.origin_asset) ?? text(request.asset);
    let assetOut = event?.destination_asset ?? text(request.destination_asset) ?? assetIn;
    const depositTx = field(details, "deposit_tx_hash");
    const address = field(details, "deposit_address");
    if (e.type === "deposit" && e.status === "SUCCESS" && depositTx && address) {
      const deposited = field(details, "deposited_amount");
      const proven = deposits.get(depositTx)!.find(t => t.address === address && (t.amount === undefined || t.amount === deposited))?.asset ?? null;
      // The chain names the asset; an API request that names another leaves it unresolved, never chosen.
      const asked = details.request && typeof details.request === "object"
        ? text((details.request as Record<string, unknown>).origin_asset) ?? text((details.request as Record<string, unknown>).asset) : null;
      assetIn = assetOut = proven && (!asked || asked === proven) ? proven : null;
    }
    rows.push({
      at: e.created_at,
      settledAt: e.updated_at,
      type: e.type,
      status: e.status,
      failureCode: e.failure_code ?? null,
      confidential: event ? event.type.startsWith("confidential_") : details.confidential === true || request.confidential === true,
      assetIn,
      amountIn: field(details, "amount") ?? event?.amount_in ?? field(details, "deposited_amount"),
      assetOut,
      amountOut: field(details, "amount_out"),
      recipient: event?.recipient ?? text(request.recipient),
      correlationId: e.correlation_id,
      intentHash: field(details, "intent_hash"),
      approvalId: field(details, "approval_id"),
      kind: op?.kind ?? null,
      planId: op?.planId ?? null,
      policyRevision: op?.policyRevision ?? null,
      policyDigest: op?.policyDigest ?? null,
      usdIn: op?.usdIn ?? null,
    });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/** Every movement of the account's public `intents.near` balance, from FastNear's Transfers API. */
const transferPage = z.object({
  transfers: z.array(z.object({ asset_id: z.string().min(1), amount: z.string().regex(/^-?\d+$/) })),
  resume_token: z.string().nullish(),
});
function publicTransfers(account: string, signal?: AbortSignal) {
  return runFastnear(indexedPages(cursor => Effect.gen(function* () {
    const raw = yield* fastnearPostEffect("https://transfers.main.fastnear.com/v0/transfers",
      { account_id: account, limit: 100, ...(cursor && { resume_token: cursor }) });
    const page = yield* decodeRead(transferPage, raw);
    return { items: page.transfers, next: page.resume_token };
  })), signal);
}

const add = (book: Map<string, bigint>, asset: string | null, amount: string | null, sign: 1n | -1n) => {
  if (asset && amount) book.set(asset, (book.get(asset) ?? 0n) + sign * BigInt(amount));
};

/** What the agent's confidential balance should hold from the API's own executions alone. */
function confidentialFlows(rows: Row[]) {
  const book = new Map<string, bigint>();
  for (const r of rows.filter((r) => r.status === "SUCCESS")) {
    if (r.type === "shield") add(book, r.assetOut, r.amountOut, 1n);
    else if (r.type === "unshield") add(book, r.assetIn, r.amountIn, -1n);
    else if (!r.confidential) continue;
    else if (r.type === "swap") {
      add(book, r.assetIn, r.amountIn, -1n);
      add(book, r.assetOut, r.amountOut, 1n);
    } else if (r.type === "transfer" || r.type === "withdraw") add(book, r.assetIn, r.amountIn, -1n);
    else if (r.type === "deposit") add(book, r.assetOut, r.amountOut, 1n);
  }
  return book;
}

type Reconciliation = {
  asset: string;
  symbol: string;
  /** Public balance: the API's figure against the chain's transfers. Any drift is an error. */
  public: { api: string; chain: string; drift: string };
  /** Confidential balance: the API's figure against its recorded executions. */
  confidential: { api: string; recorded: string; unattributed: string };
};

/** Every asset the agent holds or any source saw it move, compared with recorded flows. */
export async function reconcileBooks(id = agentId(), signal?: AbortSignal): Promise<Reconciliation[]> {
  const [rows, tokens, open, shielded, agent] = await Promise.all([
    ledger(id, signal),
    api.getTokens(),
    api.getBalances(id, { source: "public" }),
    api.getBalances(id, { source: "confidential" }),
    api.getAgent(id),
  ]);
  const account = agent.wallet?.near_account_id;
  if (!account) throw new Error("The agent has no wallet account yet");
  const chain = new Map<string, bigint>();
  for (const t of await publicTransfers(account, signal))
    if (t.asset_id.startsWith("nep245:intents.near:")) add(chain, t.asset_id.slice("nep245:intents.near:".length), t.amount, 1n);
  const recorded = confidentialFlows(rows);
  const assets = new Set([...open.balances, ...shielded.balances].map((b) => b.asset_id).concat([...chain.keys(), ...recorded.keys()]));
  return [...assets].sort().map((asset) => {
    const [pub, conf] = [rawBalance(open, asset), rawBalance(shielded, asset)];
    const [onChain, expected] = [chain.get(asset) ?? 0n, recorded.get(asset) ?? 0n];
    return {
      asset,
      symbol: tokens.find((t) => t.asset_id === asset)?.symbol ?? asset,
      public: { api: pub.toString(), chain: onChain.toString(), drift: (pub - onChain).toString() },
      confidential: { api: conf.toString(), recorded: expected.toString(), unattributed: (conf - expected).toString() },
    };
  });
}

const COLUMNS: (keyof Row)[] = [
  "at",
  "settledAt",
  "type",
  "status",
  "failureCode",
  "confidential",
  "assetIn",
  "amountIn",
  "assetOut",
  "amountOut",
  "recipient",
  "correlationId",
  "intentHash",
  "approvalId",
  "kind",
  "planId",
  "policyRevision",
  "policyDigest",
  "usdIn",
];

/** The books as CSV, raw amounts in the asset's smallest unit. `usdIn` is recorded from the mandate digest's introduction on; earlier rows leave it blank. */
export function ledgerCsv(rows: Row[]) {
  const cell = (value: unknown) => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((c) => cell(row[c])).join(","))].join("\n") + "\n";
}
