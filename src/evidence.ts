import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentId } from "./env.js";
import { allHoldings } from "./holdings.js";
import { api } from "./api.js";
import { liveGrant } from "./grants.js";
import { mandateDigest } from "./mandate.js";
import { unresolved } from "./recover.js";
import { loadStrategy } from "./strategy.js";
import { strategyDigest } from "./strategy-digest.js";
import { appendSynced } from "./synced.js";

/**
 * What each autopilot tick saw and did, `.evidence/<agent id>.jsonl` beside the ops log: append-only
 * and synced to disk, written by the scheduler itself. A tick writes a `start` line before it acts and
 * an `end` line after; a start without an end is a tick that was interrupted or whose outcome is
 * unknown. If the start can't be written, the tick doesn't run. No credentials: a grant appears by id
 * and label only.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const APP = resolve(SRC, "..");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** sha256 over every source file's path and sha256, sorted: recompute it from a snapshot to identify a build. */
export function sourceDigest(root = SRC) {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  return `sha256:${sha256(files(root).map((path) => `${relative(root, path)}\0${sha256(readFileSync(path))}`).sort().join("\n"))}`;
}
const fileDigest = (path: string) => (existsSync(path) ? `sha256:${sha256(readFileSync(path))}` : null);
/** The build's identity as far as the process can see it; the image digest comes from the deployment record. */
const BUILD = {
  deployment: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
  source: sourceDigest(),
  lockfile: fileDigest(join(APP, "pnpm-lock.yaml")),
  packageJson: fileDigest(join(APP, "package.json")),
};

type Observation = {
  at: string;
  book: { asset: string; public: string; confidential: string; usd: number }[];
  /** Each asset's share of the book against the strategy's target, in basis points. */
  weightsBps: Record<string, number>;
  targetBps: Record<string, number>;
  /** The largest distance of any asset from its target, in basis points. */
  driftBps: number;
  budget: unknown;
  unresolved: number;
};
type Seen = Observation | { error: string };

export type TickStart = {
  kind: "start";
  /** Additive progress sidecar; absent on historical runs. */
  progressVersion?: 1;
  id: string;
  at: string;
  /** `schedule`: the autopilot's timer; `operator`: "Run now". */
  trigger: "schedule" | "operator";
  /** Who pressed "Run now" through app access (`app:<deployment>:<organization>`); absent for the owner's own session. */
  actor?: string;
  /** The scheduler's settings when the tick started; `lastRun` is the tick the schedule counts from. */
  schedule: { on: boolean; everyMin: number; maxUsd: number; lastRun: string | null };
  build: typeof BUILD;
  agentId: string;
  policy: { revision: number | null; digest: string | null; status: string };
  strategy: string;
  grant: { id: string; label: string; expiresAt: string } | null;
};
export type TickEnd = {
  progressIncomplete?: boolean;
  kind: "end";
  id: string;
  endedAt: string;
  before: Seen;
  after: Seen;
  plan: { id: string; usd: number; legs: { from: string; to: string; amount: string; amountOut: string; minAmountOut: string; costBps: number }[] } | null;
  steps: { index: number; status: string; correlationId: string; failureCode: string | null }[];
  shields: { asset: string; status: string; correlationId: string }[];
  /** Why a plan was rejected before or between its sends. */
  rejected: string[];
  /** A refusal proven before anything was sent (this server's or the provider's), by code. */
  refusal: string | null;
  /** The tick's own summary, as the inbox shows it. */
  outcome: string;
};
/** A tick as read back: its start, and its end if one was written. */
export type Tick = Omit<TickStart, "kind"> & { end: Omit<TickEnd, "kind" | "id"> | null };

/** The book, drift, budget usage and open operations right now; an error instead if any read fails. */
export async function observe(): Promise<Seen> {
  try {
    const [{ managed }, view] = await Promise.all([allHoldings(), api.getPolicy(agentId())]);
    const total = managed.reduce((sum, h) => sum + h.usd, 0);
    const targetBps = loadStrategy().targetBps;
    const weightsBps = Object.fromEntries(managed.map((h) => [h.asset, total > 0 ? Math.round((h.usd / total) * 10_000) : 0]));
    const driftBps = Math.max(0, ...managed.map((h) => Math.abs((weightsBps[h.asset] ?? 0) - (targetBps[h.asset] ?? 0))));
    return {
      at: new Date().toISOString(),
      book: managed.map((h) => ({ asset: h.asset, public: h.public.toString(), confidential: h.confidential.toString(), usd: h.usd })),
      weightsBps, targetBps, driftBps,
      budget: view.usage?.budget ?? null,
      unresolved: unresolved().length,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The mandate and build a tick runs under; read failures are recorded, never fatal. */
export async function context(): Promise<Pick<TickStart, "build" | "agentId" | "policy" | "strategy" | "grant">> {
  try {
    const [view, grants] = await Promise.all([api.getPolicy(agentId()), api.listGrants(agentId())]);
    const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
    return {
      build: BUILD, agentId: agentId(),
      policy: { revision: view.revision ?? null, digest: view.policy ? mandateDigest(view.policy) : null, status: view.status },
      strategy: strategyDigest(loadStrategy()),
      grant: grant ? { id: grant.grant_id, label: grant.label, expiresAt: grant.expires_at } : null,
    };
  } catch (error) {
    return { build: BUILD, agentId: process.env.AGENT_ID ?? "", strategy: "unread", grant: null,
      policy: { revision: null, digest: null, status: `unread: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

const file = () => {
  mkdirSync(".evidence", { recursive: true });
  return join(".evidence", `${agentId()}.jsonl`);
};

export const newTickId = () => randomUUID();
export const recordStart = (start: Omit<TickStart, "kind">) => appendSynced(file(), { kind: "start", ...start } satisfies TickStart);
export const recordEnd = (end: Omit<TickEnd, "kind">) => appendSynced(file(), { kind: "end", ...end } satisfies TickEnd);

/**
 * Every tick that started at or after `since`, oldest first, each with its end if one was written.
 * A line that doesn't parse (a write cut short, most likely the last one) is counted, not trusted.
 */
export function ticks(since?: string): { ticks: Tick[]; corrupt: number[] } {
  const path = file();
  if (!existsSync(path)) return { ticks: [], corrupt: [] };
  const starts = new Map<string, Tick>();
  const corrupt: number[] = [];
  for (const [index, text] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!text.trim()) continue;
    let line: TickStart | TickEnd;
    try { line = JSON.parse(text); } catch { corrupt.push(index + 1); continue; }
    if (line.kind === "start") {
      const { kind: _kind, ...start } = line;
      starts.set(line.id, { ...start, end: null });
    } else if (line.kind === "end" && starts.has(line.id)) {
      const { kind: _kind, id: _id, ...end } = line;
      starts.get(line.id)!.end = end;
    } else corrupt.push(index + 1);
  }
  return { ticks: [...starts.values()].filter((t) => !since || t.at >= since).sort((a, b) => a.at.localeCompare(b.at)), corrupt };
}
