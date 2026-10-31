import { createTdxQuoteVerifier, InferenceClient, type TcbStatus } from "@nearai/inference-sdk/node";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import OpenAI from "openai";
import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentId } from "./env.js";
import { format, holdings } from "./holdings.js";
import { api } from "./api.js";
import { ASSETS, mayBuy } from "./policy.js";
import { type Plan, type PlannedAction, savePlan, snapshot } from "./plans.js";
import { loadStrategy } from "./strategy.js";
import type { Strategy } from "./strategy-digest.js";
import { usdValue } from "./value.js";
import { blockingWarnings, type Leg, quoteLeg, targets, warnedReason } from "./treasury.js";

/**
 * An LLM as the treasury's decision-maker, running on NEAR AI Cloud inside a TEE. Requests and
 * responses, tool calls included, are end-to-end encrypted to the attested model, and every
 * response's signature is verified. The model only proposes: its steps are saved as a plan that the
 * owner executes as proposed (see plans.ts), and the owner's policy stays the final boundary.
 */

const BASE_URL = "https://cloud-api.near.ai/v1";
export const MODEL = "z-ai/glm-5.3-flash";
const MAX_TURNS = 12;

type Symbol = keyof typeof ASSETS;
const Asset = z.enum(Object.keys(ASSETS) as [Symbol, ...Symbol[]]);
const symbolOf = (asset: string) => (Object.keys(ASSETS) as Symbol[]).find((symbol) => ASSETS[symbol] === asset);
const SwapInput = z.object({
  from: Asset,
  to: Asset,
  amount: z.string().regex(/^\d+(\.\d+)?$/).describe('Amount of `from` to sell, in whole units, e.g. "2.5"'),
});

/** Turns a model-chosen swap into a leg the shared quote/execute path understands. */
async function modelLeg({ from, to, amount }: z.infer<typeof SwapInput>): Promise<Leg> {
  if (from === to) throw new Error("from and to must differ");
  const book = await holdings();
  const holding = (symbol: Symbol) => book.find((h) => h.asset === ASSETS[symbol])!;
  const [source, target] = [holding(from), holding(to)];
  const [whole, fraction = ""] = amount.split(".");
  const raw = BigInt(whole! + fraction.padEnd(source.decimals, "0").slice(0, source.decimals));
  if (raw <= 0n) throw new Error("amount must be positive");
  if (raw > source.public + source.confidential) throw new Error(`only ${format(source.public + source.confidential, source)} held`);
  return { from: source, to: target, usd: usdValue(raw, source.decimals, source.price), amount: raw };
}

/** The output-asset refusal, before quoting: the provider would execute it (see `outputAssetRefusal`). */
async function buyRefusal(leg: Leg) {
  const { policy } = await api.getPolicy(agentId());
  return policy && !mayBuy(policy.assets, leg.to.asset) ? `REFUSED asset_out_not_allowed: ${symbolOf(leg.to.asset)} is outside the policy's assets` : null;
}

/** Policy and API refusals are answers for the model to reason about, not crashes. */
const refusal = (error: unknown) => {
  if (error instanceof AgentApiError) return `REFUSED ${error.status} ${error.code}${error.detail ? `: ${error.detail}` : ""}`;
  throw error;
};

/** A model-chosen swap with its dry quote, or the refusal to answer the model with. */
async function quoteSwap(input: z.infer<typeof SwapInput>) {
  const leg = await modelLeg(input);
  return (await buyRefusal(leg)) ?? (await quoteLeg(leg).then((quote) => ({ leg, quote }), refusal));
}

type Tool = { spec: ChatCompletionFunctionTool; run: (args: unknown) => Promise<string> };

const tool = <S extends z.ZodType>(name: string, description: string, input: S, run: (input: z.infer<S>) => Promise<string>): Tool => ({
  spec: { type: "function", function: { name, description, parameters: z.toJSONSchema(input) as Record<string, unknown> } },
  run: async (args) => run(input.parse(args)),
});

/** Tools never move money: `swap` and `shield_public` add exact actions to the plan the owner reviews. */
export function stewardTools(plan: PlannedAction[], strategy: Strategy): Tool[] {
  const { maxCostBps } = strategy;
  return [
    tool(
      "read_treasury",
      "The current book (public and confidential balances, USD values, weights vs target), the USD budget left this month, and the owner's policy.",
      z.object({}),
      async () => {
        const [book, view] = await Promise.all([holdings(), api.getPolicy(agentId())]);
        const total = book.reduce((sum, h) => sum + h.usd, 0);
        return JSON.stringify({
          total_usd: total.toFixed(2),
          book: book.map((h) => ({
            asset: symbolOf(h.asset),
            public: format(h.public, h),
            confidential: format(h.confidential, h),
            usd: h.usd.toFixed(2),
            weight: total ? (h.usd / total).toFixed(3) : "0",
            target: targets(strategy)[h.asset],
          })),
          // Every rolling window binds: the tightest one with room left decides what a swap can spend.
          budget_remaining_usd: Object.fromEntries(
            Object.entries(view.usage?.budget ?? {}).map(([window, b]) => [window, b.remaining_usd]),
          ),
          policy: view.policy,
        });
      },
    ),
    tool(
      "quote_swap",
      `Quote a swap without executing it. Returns the expected output, the floor, and the cost in basis points of the input value (swaps that could cost more than ${maxCostBps} bps at their floor are refused).`,
      SwapInput,
      async (input) => {
        const quoted = await quoteSwap(input);
        if (typeof quoted === "string") return quoted;
        const { leg, quote } = quoted;
        const warned = blockingWarnings(quote);
        return `${format(leg.amount, leg.from)} (~$${leg.usd.toFixed(2)}) → ${format(quote.amountOut, leg.to)}, floor ${format(quote.minAmountOut, leg.to)}, cost ${quote.costBps} bps, at worst ${quote.worstCostBps} bps${warned.length ? `; would not be proposed: ${warnedReason(warned)}` : ""}`;
      },
    ),
    tool(
      "swap",
      "Propose a swap of one treasury asset for another. It is quoted now and added to the plan with the quote's floor; the owner executes the plan later, held to that floor. Every swap spends the USD budget by its input value.",
      SwapInput,
      async (input) => {
        const quoted = await quoteSwap(input);
        if (typeof quoted === "string") return quoted;
        const { leg, quote } = quoted;
        if (quote.worstCostBps > maxCostBps)
          return `NOT PROPOSED: at its floor it costs ${quote.worstCostBps} bps, above ${maxCostBps} bps`;
        const warned = blockingWarnings(quote);
        if (warned.length) return `NOT PROPOSED: ${warnedReason(warned)}`;
        const { amountOut, minAmountOut, costBps } = quote;
        plan.push({ type: "swap", from: leg.from.asset, to: leg.to.asset, amount: leg.amount.toString(), amountOut, minAmountOut, costBps });
        return `PROPOSED as step ${plan.length}: swap ${format(leg.amount, leg.from)} → ${format(quote.amountOut, leg.to)}, floor ${format(quote.minAmountOut, leg.to)}, ${quote.costBps} bps`;
      },
    ),
    tool(
      "shield_public",
      "Propose moving public balances of the managed assets (USDC, wNEAR and ETH) into their confidential balances. Other assets are not included. Shielding does not spend the USD budget.",
      z.object({}),
      async () => {
        if (plan.some((a) => a.type === "shield")) return "ALREADY PROPOSED: the plan already shields the public balances";
        const exposed = (await holdings()).filter((h) => h.public > 0n);
        if (exposed.length === 0) return "no public USDC, wNEAR or ETH balances found; other assets were not checked";
        for (const h of exposed) plan.push({ type: "shield", asset: h.asset, amount: h.public.toString() });
        return `PROPOSED as steps ${plan.length - exposed.length + 1}–${plan.length}: shield ${exposed.map((h) => format(h.public, h)).join(", ")}`;
      },
    ),
  ];
}

/** The owner's strategy, in the model's instructions. */
const system = (strategy: Strategy) => `You manage a small on-chain treasury for its owner.

Target allocation by USD value: ${Object.entries(targets(strategy))
  .map(([asset, weight]) => `${symbolOf(asset)} ${weight * 100}%`)
  .join(", ")}.

Read the treasury once before acting. Before a swap, state what it does to each asset's weight. Move toward the target only when drift is worth a fee: skip legs under $${strategy.minLegUsd}, and never accept a quote that could cost more than ${strategy.maxCostBps} bps at its floor. Nothing should stay public: every swap spends and credits the confidential balance, and any public balance belongs in it.

The owner's policy is enforced outside you, by the API and the wallet provider. If an action comes back REFUSED, say which rule refused it and do not try to route around it.

You only propose. A step exists only once you call swap or shield_public and it answers PROPOSED; quote_swap proposes nothing, so never say a step is proposed without that answer. Nothing moves until the owner reviews the plan and executes it, exactly as proposed. Propose each step once.

Finish with a short report: what you saw, what you propose, and why. Write plain text, not Markdown: short paragraphs, and lists with a leading hyphen.`;

/** What a run does when the owner gives no instruction. */
const ROUTINE = "Review the treasury. Rebalance toward the target if it is worth it, and shield anything public.";

type StewardEvent =
  | { type: "say"; text: string }
  | { type: "call"; name: string; input: unknown }
  | { type: "result"; name: string; result: string }
  | { type: "verified"; completionId: string; signatureKind: string }
  | { type: "plan"; plan: Plan };

/**
 * Attestation policy for every model call; anything outside it fails before a request is sent.
 *
 * The model must be `UpToDate` and present GPU evidence: requests are encrypted to its attested
 * key and its signature is checked on every response, so it carries confidentiality and integrity.
 * The gateway, which relays that ciphertext, may also be `OutOfDate`, but only with exactly the
 * Intel advisories reviewed here (its status on 2026-10-10). A new advisory, a worse status, or any
 * change on the model side fails closed. (The SDK's default accepts `OutOfDate` with any advisory.)
 */
export const ATTESTATION = {
  modelTcb: ["UpToDate"] as readonly TcbStatus[],
  gatewayTcb: ["UpToDate", "OutOfDate"] as readonly TcbStatus[],
  gatewayAdvisories: ["INTEL-SA-01192", "INTEL-SA-01245", "INTEL-SA-01312", "INTEL-SA-01313"] as readonly string[],
};

export function verifiedInference(apiKey: string, policy = ATTESTATION) {
  const quote = createTdxQuoteVerifier();
  const inference = new InferenceClient({
    apiKey,
    baseUrl: BASE_URL,
    e2ee: true,
    gatewayVerification: {
      policy: { acceptedTcbStatuses: policy.gatewayTcb },
      verifiers: {
        // The SDK's quote check, plus the advisory pin it doesn't offer.
        tdxQuote: async (evidence) => {
          const result = await quote(evidence);
          const unreviewed = result.advisoryIds.filter((id) => !policy.gatewayAdvisories.includes(id));
          if (result.tcbStatus !== "UpToDate" && unreviewed.length > 0)
            throw new Error(`Gateway TCB ${result.tcbStatus} with unreviewed advisories ${unreviewed.join(", ")}`);
          return result;
        },
      },
    },
    modelVerification: { policy: { acceptedTcbStatuses: policy.modelTcb, gpuEvidence: "required" } },
  });
  // A turn that hangs fails fast and is retried (twice, by the SDK) rather than stalling the loop.
  const llm = new OpenAI({ apiKey, baseURL: BASE_URL, fetch: inference.fetch, timeout: 120_000 });
  return { inference, llm };
}

/**
 * Runs one decision cycle: streams what the model says, the tools it calls and what they return,
 * then saves the proposed steps as a plan to execute with `executePlan`. Nothing moves here.
 */
export async function* steward({
  instruction = ROUTINE,
  attestation = ATTESTATION,
}: { instruction?: string; attestation?: typeof ATTESTATION } = {}): AsyncGenerator<StewardEvent> {
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) throw new Error("NEARAI_API_KEY is not set");
  // Verifies the gateway and model attestations, then encrypts every request to the model's key.
  const { inference, llm } = verifiedInference(apiKey, attestation);

  // The state the plan is proposed against: execution must still find it.
  const base = await snapshot();
  const strategy = loadStrategy();
  const transcript: StewardEvent[] = [];
  const log = <E extends StewardEvent>(event: E) => (transcript.push(event), event);
  const proposed: PlannedAction[] = [];
  const toolset = stewardTools(proposed, strategy);
  const byName = new Map(toolset.map((t) => [t.spec.function.name, t]));
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system(strategy) },
    { role: "user", content: instruction },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await llm.chat.completions
      .create({ model: MODEL, messages, tools: toolset.map((t) => t.spec) })
      // The OpenAI client reports a refused attestation as a connection error: surface the refusal.
      .catch((error: unknown) => {
        throw error instanceof OpenAI.APIConnectionError && error.cause ? error.cause : error;
      });
    // The response is signed inside the TEE; check it against the exact bytes before acting on it.
    // A `gateway` signature proves only that the gateway relayed it, not that the model produced it.
    const receipt = await inference.verifyResponse(completion.id);
    if (receipt.signatureKind !== "provider_tee")
      throw new Error(`completion ${completion.id} is signed by the ${receipt.signatureKind}, not the model's TEE`);
    yield log({ type: "verified", completionId: completion.id, signatureKind: receipt.signatureKind });

    const message = completion.choices[0]?.message;
    if (!message) throw new Error(`completion ${completion.id} has no message`);
    messages.push(message);
    if (message.content) yield log({ type: "say", text: message.content });
    if (!message.tool_calls?.length) break;

    // One call at a time: two swaps from the same asset would both shield the same shortfall.
    for (const call of message.tool_calls) {
      if (call.type !== "function") continue;
      let result: string;
      try {
        const args: unknown = JSON.parse(call.function.arguments || "{}");
        yield log({ type: "call", name: call.function.name, input: args });
        const target = byName.get(call.function.name);
        result = target ? await target.run(args) : `ERROR unknown tool ${call.function.name}`;
      } catch (error) {
        result = `ERROR ${error instanceof Error ? error.message : String(error)}`;
      }
      yield log({ type: "result", name: call.function.name, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  if (messages.at(-1)?.role === "tool") yield log({ type: "say", text: `(stopped after ${MAX_TURNS} turns)` });
  if (proposed.length === 0) return;
  const plan = savePlan(base, "steward", instruction, proposed);
  saveProvenance(plan, attestation, transcript);
  yield { type: "plan", plan };
}

/**
 * Why a steward plan exists, beside it in `.plans/<id>.steward.json`: the model and attestation
 * policy, each verified completion (its id and who signed it), and what the model said, called and
 * was told. NEAR AI keeps its receipts for about an hour; this record stays.
 */
export function saveProvenance(plan: Plan, attestation: typeof ATTESTATION, transcript: StewardEvent[]) {
  const record = { planId: plan.id, model: MODEL, attestation, transcript };
  mkdirSync(".plans", { recursive: true });
  writeFileSync(join(".plans", `${plan.id}.steward.json`), JSON.stringify(record, null, 2));
}
