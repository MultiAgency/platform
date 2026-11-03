import { createHash } from "node:crypto";
import { canonical } from "./mandate.js";

/**
 * What a provider-held swap's approval commits to (docs/platform-staging.md, "What a held swap's approval commits
 * to"): each candidate canonical operation built from the approval's `request_data`, its sha256, and whether it equals
 * the provider's `request_hash`. A transfer's hash is sha256 of `{ amount, chain, flow, kind, to, token }`
 * (`payment-approval.ts`); a swap's shape is unobserved. Pure: reads nothing, sends nothing.
 */
export type HeldApproval = { request_type: string; request_data: Record<string, unknown>; request_hash: string };
export type Shape = { name: string; op: Record<string, unknown>; hash: string; matches: boolean; bindsOutput: boolean };

const defined = (op: Record<string, unknown>) => Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined));
const present = (v: unknown) => typeof v === "string" && v.length > 0;

/** An operation binds what the swap buys only if it names the output asset and the floor. */
const bindsOutput = (op: Record<string, unknown>) => present(op.token_out) && (present(op.min_amount_out) || present(op.min_out));

export function heldSwapShapes(approval: HeldApproval) {
  const d = approval.request_data;
  const confidential = { amount: d.amount, token: d.token, token_out: d.token_out, min_amount_out: d.min_amount_out, flow: "swap", kind: "confidential" };
  const candidates: [string, Record<string, unknown>][] = [
    ["request_data as given", d],
    ["request_data with kind = request_type", { ...d, kind: approval.request_type }],
    ["confidential swap op", confidential],
    ["confidential swap op with chain and to where present", { ...confidential, chain: d.chain, to: d.to }],
    ["swap op", { amount_in: d.amount_in ?? d.amount, token_in: d.token_in ?? d.token, token_out: d.token_out, min_out: d.min_out ?? d.min_amount_out, kind: "swap" }],
  ];
  const seen = new Set<string>();
  const shapes: Shape[] = [];
  for (const [name, raw] of candidates) {
    const op = defined(raw);
    const hash = createHash("sha256").update(canonical(op)).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    shapes.push({ name, op, hash, matches: hash === approval.request_hash, bindsOutput: bindsOutput(op) });
  }
  const matched = shapes.find(s => s.matches);
  // Outcome A: the hash is recomputable from request_data and covers the output asset and floor. Otherwise B.
  const outcome = matched?.bindsOutput && present(matched.op.amount ?? matched.op.amount_in) && present(matched.op.token ?? matched.op.token_in) ? "A" : "B";
  return { shapes, matched: matched?.name ?? null, outcome } as const;
}
