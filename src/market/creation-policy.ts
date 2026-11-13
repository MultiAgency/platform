import type { OwnerWallet, Policy } from "@near-intents-agent-api/sdk";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { HostedAgents } from "../gateway/hosted-agents.js";
import { ENV_FILE } from "../env.js";
import { PublicError } from "../public-error.js";
import { ASSETS, marketPolicy } from "../policy.js";
import { paymentKey } from "./payment-key.js";

/** Initial policy only: no key generation, intent, grant or money submission. */
export function fundingProofCreationPolicy(owner: OwnerWallet): Policy {
  try {
    const state = realpathSync(process.cwd()), hosted = join(state, ".hosted");
    const settingsFile = realpathSync(ENV_FILE);
    if (realpathSync(hosted) !== hosted || dirname(settingsFile) !== hosted || !statSync(settingsFile).isFile()) throw Error();
    const entries = new HostedAgents(hosted, []).list().filter(e => realpathSync(e.envFile) === settingsFile);
    const entry = entries[0], settings = parseEnv(readFileSync(settingsFile, "utf8"));
    if (entries.length !== 1 || !entry || entry.kind !== "wallet" || entry.area !== "market" ||
        !entry.deployment || !entry.organization || owner.type !== "near" || owner.account_id !== entry.owner ||
        process.env.HOSTED_OWNER !== entry.owner || process.env.HOSTED_OWNER_KIND !== "wallet" || process.env.DASHBOARD_AREA !== "market" ||
        process.env.TREASURY_ACCOUNT || settings.TREASURY_ACCOUNT || process.env.AGENT_ID || settings.AGENT_ID ||
        settings.RELEASED_AT || settings.RESTORE_REQUIRED ||
        !settings.MARKET_PAYMENT_KEY || settings.MARKET_PAYMENT_KEY !== process.env.MARKET_PAYMENT_KEY) throw Error();
    const policy = marketPolicy(paymentKey(settings).account);
    const caps = { [ASSETS.USDC]: "10000", [ASSETS.wNEAR]: "20000000000000000000000" };
    return { ...policy, limits: { per_transaction: { ...caps }, daily: { ...caps }, monthly: { ...caps } },
      max_actions_per_hour: 2, budget: { daily_usd: "1", weekly_usd: null, monthly_usd: "1" } };
  } catch {
    throw new PublicError("Funding-proof creation requires the original uncreated wallet-owned Market reservation and matching payment-key settings.");
  }
}
