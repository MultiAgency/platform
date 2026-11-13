import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseKey } from "near-kit";
import { marketPolicy } from "../../src/policy.js";
import { mandateDigest } from "../../src/mandate.js";
import type { FundingContext } from "../../src/market/funding-context.js";

/** Original hosted registry/settings shapes, on real files in a test's private state directory. */
export function fundingContextFixture(secret: string, { owner = "owner.near", kind = "wallet" }:
  { owner?: string; kind?: "wallet" | "dao" } = {}): FundingContext {
  const stateDirectory = realpathSync(process.cwd());
  const hosted = join(stateDirectory, ".hosted");
  mkdirSync(hosted, { recursive: true, mode: 0o700 });
  mkdirSync(join(stateDirectory, ".ops"), { recursive: true, mode: 0o700 });
  const name = `own-${createHash("sha256").update(`app:proof:fixture:${owner}:market`).digest("hex").slice(0, 24)}`;
  const settingsFile = join(hosted, `${name}.env`);
  if (!existsSync(settingsFile)) writeFileSync(settingsFile,
    `AGENT_ID=${process.env.AGENT_ID}\nMARKET_PAYMENT_KEY=${secret}\n${kind === "dao" ? `TREASURY_ACCOUNT=${owner}\n` : ""}`, { mode: 0o600 });
  const registry = join(hosted, "apps.json");
  if (!existsSync(registry)) writeFileSync(registry, JSON.stringify({ version: 1, entries: [
    { name, owner, kind, area: "market", port: 9000, deployment: "proof", organization: "fixture" },
  ] }), { mode: 0o600 });
  // Existing core tests use the default ENV_FILE. The canonical target is still the hosted settings file.
  if (!existsSync(".env")) symlinkSync(settingsFile, ".env");
  const paymentAccount = Buffer.from(parseKey(secret).publicKey.data).toString("hex");
  return { stateDirectory, settingsFile, ownerAccount: owner, agentId: process.env.AGENT_ID!, paymentAccount,
    reviewedPolicy: { revision: 1, digest: mandateDigest(marketPolicy(paymentAccount)) },
    reviewedGrant: { id: "fixture-grant", expiresAt: process.env.FIXTURE_MARKET_GRANT_EXPIRES ?? "2099-01-01T00:00:00.000Z" } };

}
