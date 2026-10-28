import { configuredArea } from "../area.js";
import { DIAGNOSTIC_ONLY, readSubmissionEvidence } from "../submission-evidence.js";
import { z } from "zod";
import { depositAddress } from "../agent.js";
import { dashboardHoldings } from "../dashboard-holdings.js";
import { held } from "../payouts.js";
import { api } from "../api.js";
import { isDao } from "../chain.js";
import { daoOwner, ownerFunded } from "../dao-owner.js";
import { agentId, executes } from "../env.js";
import { dismiss, readInbox } from "../inbox.js";
import { ledger, ledgerCsv, reconcileBooks } from "../ledger.js";
import { agreedPayees, notInForce } from "../authorize.js";
import { mandateDigest } from "../mandate.js";
import { countedSpend } from "../budget-window.js";
import { adoptStagedGrant, isLive, liveGrant } from "../grants.js";
import { blocksDispatch, readOps } from "../ops.js";
import { recover } from "../recover.js";
import { ASSETS } from "../policy.js";
import { loadStrategy } from "../strategy.js";
import { rebalance, targets } from "../treasury.js";
import { status } from "../owner-intents.js";
import { agreed } from "../invoices.js";
import { os, owner } from "./base.js";
import { readOutput } from "./read-output.js";
import { run, account } from "../contract/inputs.js";
import { unresolvedEvidence } from "../contract/owner-outputs.js";

/** The agent's ops log, one row per action, newest first: the request as sent, the mandate (policy revision and digest) and plan it ran under, and how it settled or was refused. */
const activity = () =>
  readOps()
    .map(({ at, kind, request, correlationId, status, refused, policyRevision, policyDigest, planId }) =>
      ({ at, kind, request, correlationId, status, refused, policyRevision, policyDigest, planId }))
    .reverse();

/**
 * The linked treasury when it is a DAO: the owner account its votes sign for, whether that
 * account exists yet, so the page can fund it, and whether it owns the agent.
 */
async function linkedDao() {
  const id = process.env.TREASURY_ACCOUNT;
  if (!id || !(await isDao(id))) return null;
  const owner = await daoOwner(id);
  return { id, owner, funded: await ownerFunded(owner) };
}

export const observationsRoutes = {

  /** Local configuration only: no provider calls or state changes. */
  instance: os.use(readOutput("instance")).handler(() => ({ agentId: process.env.AGENT_ID ?? null, executor: executes() })),
  /** Gateway ownership evidence only: no grant adoption, funding lookup or other setup work. */
  ownerIdentity: os.handler(async () => {
    const id = process.env.AGENT_ID;
    if (!id) return { agentId: null, owner: null };
    const agent = await api.getAgent(id);
    // A successful read without ownership is invalid evidence, not an outage or an uncreated agent.
    return { agentId: id, owner: agent?.owner ?? null };
  }),
  /**
   * How far onboarding has got: an agent, its owner, and a live grant whose token this server holds.
   * Adopts a staged grant token whose grant is in force, so it writes the settings file at times.
   */
  setup: os.use(readOutput("setup")).handler(async () => {
    const id = process.env.AGENT_ID;
    const dao = await linkedDao();
    if (!id) return { agentId: null, wallet: null, owner: null, grant: null, dao, executor: executes() };
    const [agent, grants] = await Promise.all([api.getAgent(id), api.listGrants(id)]);
    adoptStagedGrant(grants);
    // An approve-only copy holds no grant token: it shows the executor's grant, read from the API.
    const grant = executes()
      ? liveGrant(grants, process.env.AGENT_GRANT_TOKEN)
      : grants.filter((g) => isLive(g)).sort((a, b) => b.expires_at.localeCompare(a.expires_at))[0];
    return {
      agentId: id,
      executor: executes(),
      // The NEAR account that holds the agent's balances: where a treasury pays it.
      wallet: agent.wallet?.near_account_id ?? null,
      owner: agent.owner,
      grant: grant ? { id: grant.grant_id, label: grant.label, expiresAt: grant.expires_at } : null,
      dao,
    };
  }),
  overview: owner.overview.use(readOutput("overview")).handler(async () => {
    const id = agentId();
    const area = configuredArea(process.env.DASHBOARD_AREA);
    const [{ managed: book, unmanaged }, policy, grants] = await Promise.all([dashboardHoldings(), api.getPolicy(id), api.listGrants(id)]);
    const digest = policy.policy ? mandateDigest(policy.policy) : null;
    const strategy = loadStrategy();
    return {
      agentId: id,
      ...(area && { area }),
      book,
      unmanaged,
      target: targets(strategy),
      rebalance: { minLegUsd: strategy.minLegUsd, maxCostBps: strategy.maxCostBps },
      policy: countedSpend(policy),
      digest,
      /** Why the policy isn't in force, by the rule `authorize` refuses with; null when it is. */
      notInForce: notInForce(policy),
      agreed: policy.policy ? [...agreedPayees(policy.policy)] : [],
      grants,
    };
  }),
  /** Every revision of the owner's mandate, newest first, each with the digest anyone can recompute. */
  policyHistory: os.use(readOutput("policyHistory")).handler(async () => {
    const revisions = [];
    let cursor: number | undefined;
    do {
      const page = await api.getPolicyHistory(agentId(), { cursor, limit: 50 });
      revisions.push(...page.data);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return revisions.map((r) => ({
      revision: r.revision,
      status: r.status,
      appliedAt: r.applied_at,
      transactionHash: r.transaction_hash,
      digest: r.policy ? mandateDigest(r.policy) : null,
    }));
  }),
  deposit: os.handler(() => depositAddress(ASSETS.USDC)),
  activity: owner.activity.use(readOutput("activity")).handler(() => activity()),
  /**
   * Money actions without a proven outcome: each blocks every new one until resolved. Those held for
   * the owner's approval are listed by `held`, and invoices prepared but never sent by `invoices`.
   */
  unresolved: owner.unresolved.use(readOutput("unresolved")).handler(() => {
    const recorded = readSubmissionEvidence();
    return readOps().filter(blocksDispatch).map((op) => {
      // The provider's answer to the failed submission, when one was recorded (redacted, display only). A latest line
      // that doesn't match the published shape shows as null: the operation itself is listed either way.
      const evidence = recorded.get(op.idempotencyKey)?.at(-1);
      const shown = evidence && unresolvedEvidence.safeParse({ at: evidence.at, httpStatus: evidence.httpStatus, code: evidence.code,
        requestId: evidence.requestId, providerIds: evidence.providerIds, message: evidence.message, note: DIAGNOSTIC_ONLY });
      return { key: op.idempotencyKey, at: op.at, kind: op.kind, request: op.request, status: op.status ?? null, sent: Boolean(op.correlationId),
        evidence: shown?.success ? shown.data : null };
    });
  }),
  /** Reads existing operation statuses; sends nothing. */
  recover: os.handler(async () =>
    (await recover()).map(({ op, outcome, status, detail }) => ({ key: op.idempotencyKey, outcome, status: status ?? null, detail: detail ?? null })),
  ),
  inbox: {
    // Every open message, however old, so dismissing a repeated one clears every copy; and the latest runs.
    list: os.use(readOutput("inbox/list")).handler(() => {
      const entries = readInbox();
      const runs = new Set(entries.filter((e) => e.level === "run").slice(0, 20));
      return entries.filter((e) => (e.level === "run" ? runs.has(e) : !e.dismissed));
    }),
    dismiss: os.input(z.object({ id: z.uuid() })).handler(({ input }) => dismiss(input.id)),
  },
  /** The books: every money execution with its assets, evidence and the mandate it ran under. */
  ledger: os.use(readOutput("ledger")).handler(() => ledger()),
  ledgerCsv: os.use(readOutput("ledgerCsv")).handler(async () => ledgerCsv(await ledger())),
  /** Each balance against its independent record: the chain for public, the API's executions for confidential. */
  reconcileBooks: os.use(readOutput("reconcileBooks")).handler(() => reconcileBooks()),
};
