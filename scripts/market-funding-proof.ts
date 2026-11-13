/** Owner-run only. No API route, key generation, deployment or owner signing. */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { hireTerms, marketBrief, payoutRequestId } from "../src/contract/inputs.js";
import { ASSETS } from "../src/policy.js";
import { isAbsolute } from "node:path";
import { assertFundingPaths, fundingContextSchema } from "../src/market/funding-context.js";
import { OPEN_ACCOUNT_WNEAR } from "../src/market/x402.js";

const reviewSchema = fundingContextSchema.extend({
  actor: z.string().min(1), requestId: payoutRequestId, brief: marketBrief, approved: hireTerms,
  providerOrigin: z.url(), approvalExpiresAt: z.number().int().positive(),
  maxUsdc: z.string().regex(/^[1-9][0-9]*$/), maxOpeningWnear: z.literal(OPEN_ACCOUNT_WNEAR),
}).strict();

const [reviewFile, execute, ...extra] = process.argv.slice(2);
if (!reviewFile || execute !== "--execute" || extra.length)
  throw new Error("Usage: tsx scripts/market-funding-proof.ts /private/approved-review.json --execute (moves real funds)");
const review = reviewSchema.parse(JSON.parse(readFileSync(reviewFile, "utf8")));
// Refuse the wrong cwd/settings before loading application configuration or journal helpers.
if (!process.env.ENV_FILE || !isAbsolute(process.env.ENV_FILE))
  throw new Error("Funding requires an explicit absolute ENV_FILE matching the reviewed settings");
assertFundingPaths(review, process.env.ENV_FILE);
const { agentId, executes } = await import("../src/env.js");
const { paymentKey } = await import("../src/market/payment-key.js");
if (!executes() || agentId() !== review.agentId || paymentKey().account !== review.paymentAccount)
  throw new Error("Executor, agent or isolated payment account does not match the review");
const origin = new URL(process.env.NEAR_INTENTS_AGENT_API_URL ?? "https://api.demo.agentsonintents.com").origin;
if (review.providerOrigin !== origin || !origin.startsWith("https://"))
  throw new Error("Provider origin does not match the review");
if (`nep141:${review.approved.asset}` !== ASSETS.USDC || review.approved.amount !== review.maxUsdc || BigInt(review.maxUsdc) > 10_000n)
  throw new Error("Funding proof allows at most 10000 USDC base units and requires the exact reviewed amount");
if (review.approvalExpiresAt <= Date.now() || review.approvalExpiresAt > Date.now() + 3_600_000)
  throw new Error("Approval deadline must be live and no more than one hour away");
// Import after validating operator inputs. The function has no Market challenge or paid-call path.
const { fundMarketOnly } = await import("../src/market/hire.js");
const result = await fundMarketOnly(review.actor, review, review.approvalExpiresAt, review);
console.log(JSON.stringify(result));
