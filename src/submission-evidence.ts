import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { agentId } from "./env.js";
import { appendSynced, mkdirSynced } from "./synced.js";

/**
 * What the provider answered when a claimed submission failed without a proven outcome. It is evidence for a later,
 * separately authorized resolution, never a resolution: the operation stays unresolved and nothing reads this file to
 * decide a send. It sits beside the journal, not in it, so the strict journal reader (and older builds' readers) never
 * see it. The name doesn't end in `.jsonl`, which journal checks treat as an agent journal.
 */
export type SubmissionEvidence = {
  idempotencyKey: string;
  at: string;
  httpStatus: number;
  code: string;
  /** Every listed error code, in order. */
  codes: string[];
  retryable: boolean;
  /** The provider's id for the failed request (response `meta.request_id`), for provider-side lookup. */
  requestId: string | null;
  /** Any operation or correlation id the provider included, though its error document defines none. */
  providerIds: Record<string, string>;
  /** The first error's title and detail, shortened and with credential-like values removed. */
  message: string;
};

const MAX_MESSAGE = 200;
const CREDENTIAL = /\b(?:naa|ngt|nga|tac)_[A-Za-z0-9_-]+|Bearer\s+\S+|\b[A-Za-z0-9+/_-]{40,}={0,2}/g;
const ID_KEY = /^(?:correlation|operation)_?id$/i;

export function evidenceLog() {
  mkdirSynced(".ops");
  return join(".ops", `${agentId()}.submission-evidence.ndjson`);
}

const redact = (text: string) => {
  const clean = text.replace(CREDENTIAL, "[redacted]").replace(/\s+/g, " ").trim();
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
};

/** The provider's error response, or nothing: a lost reply or transport failure carries no provider evidence. */
export function evidenceOf(error: unknown): Omit<SubmissionEvidence, "idempotencyKey" | "at"> | undefined {
  if (!(error instanceof AgentApiError)) return undefined;
  const providerIds: Record<string, string> = {};
  for (const entry of error.errors) {
    for (const [key, value] of Object.entries((entry.meta ?? {}) as Record<string, unknown>))
      if (ID_KEY.test(key) && typeof value === "string" && value.length <= 200) providerIds[key] = value;
  }
  const first = error.errors[0];
  return {
    httpStatus: error.status, code: error.code, codes: error.errors.map(entry => entry.code), retryable: error.retryable,
    requestId: error.requestId ?? null, providerIds,
    message: redact([first?.title ?? error.title, first?.detail ?? error.detail].filter(Boolean).join(": ")),
  };
}

/**
 * Appends the evidence for a failed claimed submission. Best effort by design: a failure to write evidence must never
 * replace or hide the send's own error, so it is reported and swallowed.
 */
export function recordSubmissionEvidence(idempotencyKey: string, error: unknown) {
  const evidence = evidenceOf(error);
  if (!evidence) return;
  try { appendSynced(evidenceLog(), { idempotencyKey, at: new Date().toISOString(), ...evidence } satisfies SubmissionEvidence); }
  catch (cause) { console.error(`Submission evidence for ${idempotencyKey} was not recorded:`, cause); }
}

/** The evidence recorded for each operation, oldest first. Display only: a malformed line is skipped, never trusted. */
export function readSubmissionEvidence(): Map<string, SubmissionEvidence[]> {
  const byKey = new Map<string, SubmissionEvidence[]>();
  const file = evidenceLog();
  if (!existsSync(file)) return byKey;
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (!text.trim()) continue;
    let line: SubmissionEvidence;
    try { line = JSON.parse(text); } catch { continue; }
    if (typeof line?.idempotencyKey !== "string" || typeof line.code !== "string") continue;
    byKey.set(line.idempotencyKey, [...(byKey.get(line.idempotencyKey) ?? []), line]);
  }
  return byKey;
}

/**
 * One line for operators: what the provider said, and the id to quote to it. A request id identifies the failed request
 * for diagnosis; it proves neither which provider operation it became nor whether anything executed, and it is no
 * permission to clear the operation.
 */
export const DIAGNOSTIC_ONLY = "Diagnostic only: this doesn't establish provider correlation or execution, or permission to clear the operation.";
export const describeEvidence = (evidence: SubmissionEvidence) =>
  `provider ${evidence.httpStatus} ${evidence.code}${evidence.requestId ? `, request ${evidence.requestId}` : ""}${
    Object.keys(evidence.providerIds).length ? `, ${Object.entries(evidence.providerIds).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""} at ${evidence.at}. ${DIAGNOSTIC_ONLY}`;
