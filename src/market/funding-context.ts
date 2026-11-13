import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { PublicError } from "../public-error.js";

/** Local host identity reviewed before running a controlled funding observation. */
export const fundingContextSchema = z.object({
  stateDirectory: z.string().refine(isAbsolute, "State directory must be absolute"),
  settingsFile: z.string().refine(isAbsolute, "Settings file must be absolute"),
  ownerAccount: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  agentId: z.string().regex(/^[a-f0-9]{64}$/),
  paymentAccount: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedPolicy: z.strictObject({ revision: z.number().int().nonnegative(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  reviewedGrant: z.strictObject({ id: z.string().min(1), expiresAt: z.iso.datetime({ offset: true }) }),
});
export type FundingContext = z.infer<typeof fundingContextSchema>;

/** Read-only bootstrap: never creates state or changes cwd to make a review pass. */
export function assertFundingPaths(raw: unknown, selectedSettings: string): FundingContext {
  const context = fundingContextSchema.parse(raw);
  const state = realpathSync(context.stateDirectory);
  if (!statSync(state).isDirectory() || realpathSync(process.cwd()) !== state)
    throw new Error("Funding state directory does not match the current canonical working directory");
  const hosted = join(state, ".hosted"), ops = join(state, ".ops");
  if (realpathSync(hosted) !== hosted || !statSync(hosted).isDirectory() ||
      realpathSync(ops) !== ops || !statSync(ops).isDirectory())
    throw new Error("Funding state directories must be existing canonical directories");
  const settings = realpathSync(context.settingsFile);
  if (!selectedSettings || realpathSync(resolve(selectedSettings)) !== settings || dirname(settings) !== hosted ||
      !statSync(settings).isFile())
    throw new Error("Funding settings file does not match the reviewed hosted settings");
  const journal = join(ops, `${context.agentId}.jsonl`);
  const journalStat = lstatSync(journal, { throwIfNoEntry: false });
  if (journalStat && (!journalStat.isFile() || realpathSync(journal) !== journal))
    throw new Error("Funding journal is not the canonical regular file");
  return context;
}

/** The registry establishes wallet ownership; absence of gateway environment variables never does. */
export async function assertFundingContext(raw: unknown): Promise<FundingContext> {
  try { return await checkedFundingContext(raw); }
  catch (error) {
    if (error instanceof PublicError) throw error;
    // Context failures must propagate even when this request already has a landed funding stage.
    throw new PublicError("Funding context is unavailable or conflicting. Preserve its original records; no further submission is authorized.");
  }
}

async function checkedFundingContext(raw: unknown): Promise<FundingContext> {
  const context = fundingContextSchema.parse(raw);
  const { ENV_FILE, agentId, executes } = await import("../env.js");
  // Check paths before loading application helpers which may later inspect state.
  assertFundingPaths(context, ENV_FILE);
  const { HostedAgents } = await import("../gateway/hosted-agents.js");
  const { paymentKey } = await import("./payment-key.js");
  const local = () => {
    assertFundingPaths(context, ENV_FILE);
    const settings = parseEnv(readFileSync(context.settingsFile, "utf8"));
    const matches = new HostedAgents(join(realpathSync(context.stateDirectory), ".hosted"), []).list()
      .filter(entry => realpathSync(entry.envFile) === realpathSync(context.settingsFile));
    const entry = matches[0];
    if (matches.length !== 1 || !entry || entry.area !== "market" || entry.kind !== "wallet" ||
        entry.owner !== context.ownerAccount || settings.TREASURY_ACCOUNT || process.env.TREASURY_ACCOUNT ||
        process.env.HOSTED_OWNER_KIND && process.env.HOSTED_OWNER_KIND !== "wallet" ||
        process.env.HOSTED_OWNER && process.env.HOSTED_OWNER !== entry.owner)
      throw new PublicError("Funding observation needs a matching durable wallet-owner reservation; wallet owners only");
    if (!executes() || settings.EXECUTOR === "off" || settings.AGENT_ID !== context.agentId || agentId() !== context.agentId ||
        !settings.MARKET_PAYMENT_KEY || settings.MARKET_PAYMENT_KEY !== process.env.MARKET_PAYMENT_KEY ||
        paymentKey().account !== context.paymentAccount)
      throw new PublicError("Funding settings and runtime agent/payment identity differ from the review");
  };
  local();
  const { api } = await import("../api.js");
  const [agent, policy, grants] = await Promise.all([
    api.getAgent(context.agentId), api.getPolicy(context.agentId), api.listGrants(context.agentId),
  ]);
  local(); // A provider read must not let changed settings or registry ownership authorize a send.
  const owner = agent.owner;
  if (agent.id !== context.agentId || agent.status !== "ACTIVE" || agent.archived || agent.deleted ||
      !owner || owner.type !== "near" || owner.account_id !== context.ownerAccount)
    throw new PublicError("Funding provider agent does not match the reviewed active wallet owner");
  const { mandateDigest } = await import("../mandate.js");
  const { liveGrant } = await import("../grants.js");
  if (!policy.policy || policy.revision !== context.reviewedPolicy.revision ||
      mandateDigest(policy.policy) !== context.reviewedPolicy.digest)
    throw new PublicError("Funding reviewed policy differs from the provider's current policy. Review again before submitting.");
  const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  if (!grant || grant.label !== "market" || grant.agent_id !== context.agentId ||
      grant.grant_id !== context.reviewedGrant.id || Date.parse(grant.expires_at) !== Date.parse(context.reviewedGrant.expiresAt))
    throw new PublicError("Funding reviewed grant differs from the live market grant. Review again before submitting.");
  return context;
}
