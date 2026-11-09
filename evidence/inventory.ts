/**
 * Each area's briefs, requirement by requirement. Every requirement is one of its brief's use cases or
 * outcomes in the Agent Connect experiment catalog, in the catalog's words where they fit, split where the
 * catalog mixes two kinds: a capability (what the agent can do) or a guarantee (what it can't). A guarantee
 * says who stops a misbehaving agent; the claim is only as strong as what doesn't rest on this server.
 * Every row says how it's known. Static on purpose: every line states evidence someone can check, so a
 * change here is a reviewed change. This is the canonical inventory: the app imports it and
 * pnpm evidence:write generates the documentation tables. Evidence is a dated,
 * described observation; the only raw ids are proposal numbers, which are public on chain.
 */

export const REQUIREMENTS_CONTEXT = "These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.";

export type Kind = "facilitator" | "treasury";

/** Who stops a misbehaving agent: the signed policy (the provider, or the chain for a DAO's vote), this server, nobody here can, or nothing yet. */
export type Stopper = "policy" | "server" | "impossible" | "nothing";

/** How it's known: seen on mainnet with real funds, covered by offline tests, supported by pinned provider source, or not yet. */
export type Known = "mainnet" | "offline" | "provider-source" | "not-yet";

/**
 * A capability (what the agent can do) or a guarantee (what it can't); only a guarantee has `stoppedBy`.
 * `where`: for one seen on mainnet, this area's own agent or another (the other area's, or an isolated test
 * agent). `proposals`: the DAO proposals the evidence cites, linked to where anyone can read them.
 */
export type Requirement = {
  type: "capability" | "guarantee";
  text: string;
  stoppedBy?: Stopper;
  known: Known;
  where?: "agent" | "other";
  evidence: string;
  proposals?: number[];
};

/** A brief from the Agent Connect experiment catalog, by its catalog number. An area lists the brief it runs first, then its roadmap. */
export type Brief = { catalog: string; title: string; requirements: Requirement[]; limitations?: string[] };

/** A demo step; `on` says which site it happens on. */
export type Step = { text: string; on: "invoices" | "dashboard" };

export const PROTOTYPES: Record<Kind, { name: string; tagline: string; briefs: [Brief, ...Brief[]]; demo: Step[] }> = {
  facilitator: {
    name: "Payables",
    tagline:
      "Payees submit invoices without contacting a DAO member. The payout agent holds funds in its confidential balance and files each payment for the DAO's vote.",
    briefs: [
      {
        catalog: "01",
        title: "Confidential Treasury Facilitator",
        // Public-safe limitations, not private observations. Also generated into the planning docs.
        limitations: [
          "The council roster is public on Sputnik.",
          "Approval timing is public; providers can see the payout mapping. Confidential transfers do not establish protection against every form of tracing.",
          "Invoice ceilings and deadlines are shown to voters, not automatically enforced.",
        ],
        requirements: [
          {
            type: "capability",
            text: "A contractor invoices the DAO and gets paid",
            known: "mainnet",
            where: "agent",
            evidence:
              "Invoices filed at invoices.multiagency.ai, voted and paid on the payout agent, 2026-10-12 and 2026-10-13 (docs/mainnet-log.md; DEMO.md \"What is verified\")",
            proposals: [47, 50, 53, 54],
          },
          {
            type: "capability",
            text: "Requests reach the DAO without contacting a member",
            known: "mainnet",
            where: "agent",
            evidence:
              "A payee signs in on the invoice page and files there; the DAO votes on the held payment. Invoices filed and paid that way on the payout agent, 2026-10-12 and 2026-10-13",
            proposals: [47, 53, 54],
          },
          {
            type: "guarantee",
            text: "No payment moves without the members' vote",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "The payout policy holds every payment for the owner, and the owner is the DAO, so only its on-chain vote releases one. Held and released by vote on the payout agent, 2026-10-11 to 2026-10-14",
            proposals: [26, 47, 53, 54, 56],
          },
          {
            type: "guarantee",
            text: "The contractor can't learn the council roster",
            stoppedBy: "impossible",
            known: "offline",
            evidence:
              "Not possible on Sputnik: a DAO's roles are public on chain. Our invoice page never reads them (test/invoice-roster.test.ts)",
          },
          {
            type: "capability",
            text: "A bounty program pays winners from the private balance",
            known: "mainnet",
            where: "agent",
            evidence:
              "The DAO offered an award; the winner filed under it on the invoice page and was paid confidentially from the payout agent after the DAO's vote, 2026-10-14 (test/agreements.test.ts)",
            proposals: [56],
          },
          {
            type: "capability",
            text: "A new payee's request is routed to a new agreement",
            known: "mainnet",
            where: "agent",
            evidence:
              "An account the DAO hadn't agreed to pay filed on the invoice page, 2026-10-14 00:55Z: recorded as an agreement request, nothing sent to the provider, then declined from the dashboard's Agreements (test/invoice-http.test.ts)",
          },
          {
            type: "guarantee",
            text: "No one outside the DAO's agreement is paid",
            stoppedBy: "policy",
            known: "mainnet",
            where: "other",
            evidence:
              "The destination list is the agreement, and changing it takes the DAO's signature. An unlisted account refused with policy_destination_denied on the treasury agent, 2026-10-11; the treasury agent's list changed only by DAO vote",
            proposals: [23, 24, 25],
          },
          {
            type: "guarantee",
            text: "An over-limit payment can't go through, even with votes",
            stoppedBy: "policy",
            known: "provider-source",
            evidence:
              "Enforced by the signed policy, per OutLayer source (b8c58c0): the keystore re-checks the per-transaction cap before signing, after the vote; not observed on the deployed provider. Our approval re-check is tested offline (test/authorize.test.ts, test/two-machine.test.ts). A cap refusal was seen on the treasury agent, 2026-10-11, with no vote involved",
          },
          {
            type: "guarantee",
            text: "Chain watchers can't reconstruct the DAO's payout graph",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "Payees are confidential destinations in the policy, so a public payout matches none. The payout agent's account has no public transactions and the payee sees no sender, 2026-10-11. Limits: each approval is a public proposal whose timing shows, and 1Click and NEAR Intents can see the mapping",
          },
        ],
      },
      {
        catalog: "03",
        title: "Work orders",
        requirements: [
          {
            type: "capability",
            text: "Each work order has a dedicated agent and expiring grant, with owner-approved invoice payment",
            known: "offline",
            evidence:
              "Buyer flow implemented in Payables and the invoice portal. Offline tests cover fixed policy/grant requests, process isolation, authenticated intake, concurrent filing and restart identity (test/work-order-*.test.ts; Payables' test/browser/work-orders.cjs). Funding and settlement on a deployed work-order agent remain unobserved; residual-fund return is not built",
          },
          {
            type: "guarantee",
            text: "Work-order payments are confidential; business-supplier unlinkability remains unverified",
            stoppedBy: "policy",
            known: "offline",
            evidence:
              "The work-order policy and request require a confidential transfer (test/work-order-binding.test.ts). Provider visibility, timing and public approvals can reveal relationships. No work order paid on mainnet",
          },
          {
            type: "capability",
            text: "Inbound payments are swapped to stables and forwarded to the supplier's treasury",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "A tampered order (wrong supplier, changed amount, late) is refused",
            stoppedBy: "server",
            known: "offline",
            evidence:
              "Work-order dispatch locally binds the exact invoice identity, payee, asset, amount, policy digest and grant deadline. Offline tests refuse altered terms and expiry during final reads (test/work-order-binding.test.ts). No work-order refusal observed on mainnet; accepted payments may finish after the deadline",
          },
        ],
      },
      {
        catalog: "17",
        title: "Campaign payouts",
        requirements: [
          {
            type: "capability",
            text: "A winners list is paid in one auditable batch",
            known: "not-yet",
            evidence:
              "Not built: each award is its own invoice and vote",
          },
          {
            type: "capability",
            text: "Recurring disbursements run as scheduled, individually budgeted transfers",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "capability",
            text: "Refund waves use the same mechanics",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "A duplicate winner or inflated prize can't pay twice",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built: campaign winner identity and prize validation. Offline tests cover only a manual payout matching the recipient, asset and amount of an existing held payout (test/authorize.test.ts). Provider replay deduplication is unverified.",
          },
          {
            type: "guarantee",
            text: "A payout outside the campaign's list is refused",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built: payees are the policy's agreed list; there is no campaign list",
          },
        ],
      },
    ],
    demo: [
      { on: "invoices", text: "Sign in with NEAR and ask to be paid. Someone the DAO hasn't agreed to pay files a request; nothing is paid." },
      { on: "dashboard", text: "On Agreements, agree to the request's terms. That files a policy update for the DAO's vote." },
      { on: "invoices", text: "Once agreed, the payee files the invoice. It is held for the DAO's vote." },
      { on: "dashboard", text: "In Payments, open the invoice and review its terms before owner approval. Approval and settlement are separate: follow the payment until success, then inspect its record in Activity." },
    ],
  },
  treasury: {
    name: "Treasury",
    tagline:
      "The treasury agent rebalances toward its target on its own, quoting every swap, inside per-asset caps and a USD budget the DAO signed. Idle funds stay in the confidential balance.",
    briefs: [
      {
        catalog: "02",
        title: "Agentic Treasury Management",
        limitations: [
          "This executor's own simultaneous sends can't overrun asset limits or the USD budget (tested offline); whether other senders' simultaneous requests can is the provider's, and unverified.",
          "This server checks which assets can be bought; the provider does not.",
          "This server requests confidential swaps, but the policy also permits public swaps and moving funds back to a public balance. A confidential balance does not establish protection against every form of tracing.",
          "The agent has not yet run unattended for days.",
        ],
        requirements: [
          {
            type: "capability",
            text: "Rebalances to target allocations on a schedule",
            known: "mainnet",
            where: "agent",
            evidence:
              "The autopilot executed a rebalance alone, its plan bound to the strategy digest, 2026-10-12 16:17Z (test/autopilot.test.ts, test/rebalance.test.ts)",
          },
          {
            type: "guarantee",
            text: "Can't exceed per-asset limits",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "The policy caps every asset per transaction, hour, day and month. On the treasury agent, a transfer over its hourly cap was refused with policy_denied (policy revision 8, 2026-10-11); a swap over the monthly cap was refused on an isolated test agent, 2026-10-13. Offline, this executor's simultaneous payouts never got a daily cap admitted past it by a simulated provider that admits racily (test/spending-limits-race.test.ts)",
          },
          {
            type: "capability",
            text: "Quotes every route before executing",
            known: "mainnet",
            where: "agent",
            evidence:
              "Two quoted legs executed on the treasury agent, 2026-10-12 20:36Z (test/rebalance.test.ts, test/plans.test.ts)",
          },
          {
            type: "capability",
            text: "Shows budget headroom ticking down with each dispatch",
            known: "mainnet",
            where: "agent",
            evidence:
              "On the treasury agent, a Run now swap took the daily budget left down by its value, shown as before and after under Automations' Latest run, 2026-10-14 00:50Z. The Overview and each run show the window with least left (test/budget-window.test.ts)",
          },
          {
            type: "guarantee",
            text: "An over-budget operation is refused; earlier operations in its run may complete",
            stoppedBy: "policy",
            known: "mainnet",
            where: "agent",
            evidence:
              "Refused with spend_budget_exceeded, nothing moved, on the treasury agent, 2026-10-12 13:57Z and 14:06Z",
          },
          {
            type: "guarantee",
            text: "Can't spend more than the USD budget, even with simultaneous requests",
            stoppedBy: "policy",
            known: "mainnet",
            where: "other",
            evidence:
              "Five simultaneous swaps on an isolated test agent: one settled, the rest refused, no overshoot, 2026-10-13 (one trial). Offline, this executor's simultaneous swaps never got the budget admitted past it by a simulated provider that admits racily (test/spending-limits-race.test.ts)",
          },
          {
            type: "capability",
            text: "Sweeps idle stables into the confidential balance",
            known: "mainnet",
            where: "agent",
            evidence:
              "A small USDC deposit to a public deposit address landed in the treasury agent's public balance; the dashboard's Sweep (the same sweep the autopilot runs each tick) shielded it, and nothing was left public, 2026-10-14 00:33Z to 00:39Z (test/autopilot.test.ts)",
          },
          {
            type: "guarantee",
            text: "The resting position can't be traced on chain",
            stoppedBy: "server",
            known: "mainnet",
            where: "agent",
            evidence:
              "No public NEAR Intents balance on chain and all three assets confidential, read-only check, 2026-10-13T23:03Z. Kept so by our deposits' and swaps' requests: the policy allows public swaps and unshield (docs/enforcement.md). Funds still can't leave: the destination list is empty",
          },
        ],
      },
      {
        catalog: "09",
        title: "Adaptive DCA",
        requirements: [
          {
            type: "capability",
            text: "Daily buys of listed tokens, sized between a floor and a cap by a signal",
            known: "not-yet",
            evidence:
              "Not built: the strategy is a target allocation",
          },
          {
            type: "capability",
            text: "Pauses on a cold streak or regime change",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "A token outside the list can't be bought",
            stoppedBy: "server",
            known: "offline",
            evidence:
              "The provider checks only the asset a swap spends; our server refuses buying an unlisted one (test/authorize.test.ts). A swap into an unlisted asset succeeded through the API directly, 2026-10-10",
          },
          {
            type: "guarantee",
            text: "A buy can't exceed the per-cycle cap",
            stoppedBy: "policy",
            known: "not-yet",
            evidence:
              "The policy's per-transaction and hourly caps would stop it; DCA isn't built",
          },
        ],
      },
      {
        catalog: "18",
        title: "House Money",
        requirements: [
          {
            type: "capability",
            text: "The principal moves to a safe account once gains cover it, exactly once",
            known: "not-yet",
            evidence:
              "Not built: the treasury agent's policy lets no funds leave",
          },
          {
            type: "guarantee",
            text: "Drawdowns can't touch the banked principal",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built",
          },
          {
            type: "guarantee",
            text: "Nothing comes back from the safe account",
            stoppedBy: "nothing",
            known: "not-yet",
            evidence:
              "Not built",
          },
        ],
      },
      {
        catalog: "08",
        title: "Bitcoin treasury",
        requirements: [
          {
            type: "capability",
            text: "Inbound BTC lands in a public checking balance from any sender",
            known: "not-yet",
            evidence:
              "Not built: no BTC asset, and deposits land confidential",
          },
          {
            type: "capability",
            text: "One-time deposit addresses with refund destinations, reconciled from provider records",
            known: "not-yet",
            evidence:
              "Partly built: one-time deposit addresses and reconciliation from the provider's history exist; no refund destinations",
          },
          {
            type: "capability",
            text: "A scheduled sweep to the confidential treasury, within a cap and a delay",
            known: "not-yet",
            evidence:
              "Partly built: every tick shields public balances; no separate treasury and no delay",
          },
          {
            type: "guarantee",
            text: "An oversized sweep is refused at the per-transaction cap",
            stoppedBy: "policy",
            known: "not-yet",
            evidence:
              "The policy caps each transaction; not shown for a sweep",
          },
          {
            type: "capability",
            text: "The owner can cancel a sweep during the veto window",
            known: "not-yet",
            evidence:
              "Not built: needs the provider's timelock tested on mainnet first",
          },
        ],
      },
    ],
    demo: [
      { on: "dashboard", text: "Overview: the latest recorded run, the book against its target, and the binding USD budget left." },
      { on: "dashboard", text: "Strategy: preview a rebalance. Each leg is quoted and checked against the strategy's cost cap." },
      { on: "dashboard", text: "Runs → Run now: follow the recorded sends and compare the budget before and after." },
      { on: "dashboard", text: "Activity: each swap with the policy revision it ran under." },
    ],
  },
};

export const STOPPER_LABEL: Record<Stopper, string> = {
  policy: "The signed policy",
  server: "Our server",
  impossible: "Not possible on Sputnik",
  nothing: "Nothing yet",
};

/** An observation records evidence; it does not establish a guarantee in all cases. */
export const knownLabel = (r: Requirement) =>
  r.known === "mainnet" ? `Observed on mainnet${r.where === "other" ? ", on another agent" : ""}` : r.known === "offline" ? "Tested offline" : r.known === "provider-source" ? "Per pinned provider source; deployed behavior unverified" : "Not yet";

/** Mutually exclusive evidence categories, never a completion or enforcement score. */
export function summarizeRequirements(requirements: readonly Requirement[]) {
  const summary = { total: requirements.length, agent: 0, other: 0, offline: 0, unverified: 0, unsupported: 0 };
  for (const requirement of requirements) {
    if (requirement.stoppedBy === "impossible") summary.unsupported++;
    else if (requirement.known === "mainnet" && requirement.where === "agent") summary.agent++;
    else if (requirement.known === "mainnet" && requirement.where === "other") summary.other++;
    else if (requirement.known === "offline") summary.offline++;
    else summary.unverified++;
  }
  return summary;
}

/** Historical deployment context; generated into DEMO.md, never a claim about an untested build. */
export const VERIFICATION_CONTEXT = [
  "The table was checked on the 2026-10-12 build: dao `aa6ec064` and invoices `a3aa194a`, from commit `fe3330c`.",
  "The current deployment is dao `4becd066` (2026-10-14 01:32Z), from a clean export of commit `5cd6cc9` per the",
  "deployer (Railway records no commit), and invoices `fcdc06a6` (2026-10-13 22:46:57Z), from `9b2941a`: `d9cb581` and",
  "`5cd6cc9` changed only dashboard pages and docs. Its bundle carries `5cd6cc9`'s card text. After the deploy",
  "`pnpm smoke` passed against both hosts, signed out and signed in as the operator, Automations showed the \"Latest",
  "run\" panel, and `pnpm demo-check` passed (02:00Z). Before it, dao `708557e6` (01:23Z) served the same pages but the",
  "earlier card text: smoke passed signed out and signed in as the operator, and Automations showed the \"Latest run\"",
  "panel with the treasury's 00:50Z run, with Steward out of the treasury menu. Earlier still, dao `0d5964ea` (00:43Z,",
  "from `d9cb581`), whose text checks on the card bundle these rows refer to. Of the table, the first, second and fourth rows",
  "have been re-checked on it, and the signed-in operator reads. Before it: dao `2d08148b` (2026-10-13 22:48:02Z, from `9b2941a`), after which the operator",
  "signed in and opened both agents under the per-agent owner check; and earlier dao `cd3115ee` and invoices `1be6e29c`",
  "(18:31–18:32Z, from `37cbba2`). Operation ids and amounts for the rows below are in the private release record."
].join("\n");

export const VERIFICATIONS: { claim: string; evidence: string; when: string; publicClaim?: string }[] = [
  {
    "claim": "Both hosts healthy; signed-out callers refused every agent read; cross-site writes refused",
    "evidence": "`pnpm smoke`, live, read-only",
    "when": "2026-10-12 22:13Z; re-checked on dao `0d5964ea` / invoices `fcdc06a6`, 2026-10-14 00:48Z",
    "publicClaim": "Signed-out callers are refused every agent read"
  },
  {
    "claim": "One executor per agent",
    "evidence": "Railway: one live deployment each, older ones removed",
    "when": "2026-10-12 22:13Z; re-checked 2026-10-14 00:48Z",
    "publicClaim": "One executor per agent"
  },
  {
    "claim": "State survives a restart and a redeploy",
    "evidence": "Signed-in smoke snapshot before and after",
    "when": "2026-10-12 20:50–21:37Z",
    "publicClaim": "State survives a restart and a redeploy"
  },
  {
    "claim": "Autopilot runs on schedule on that build",
    "evidence": "First tick's evidence: scheduled, build digests match",
    "when": "2026-10-12 21:37Z; re-checked on dao `0d5964ea`: the first scheduled tick, 2026-10-14 00:46:01Z, records that deployment",
    "publicClaim": "The autopilot runs on schedule on the deployed build"
  },
  {
    "claim": "Invoice → DAO approval → payment, paid",
    "evidence": "Submitted at 21:46Z, inferred, by the deployed `invoices` service; approval prepared on an unidentified host, not this laptop's stores; proposal 50 filed and voted in two transactions; executed by the provider: SUCCESS",
    "when": "2026-10-12 21:48Z"
  },
  {
    "claim": "Same flow, provider reported FAILED; nonpayment not independently verified",
    "evidence": "Submitted at 22:16Z, inferred, by the deployed `invoices` service; approval prepared and signed by the user's local approve-only server running the one-click code, uncommitted at the time (proposal 51); executed by the provider: FAILED, reason redacted (an empty wallet afterwards suggests insufficient funds, unproven)",
    "when": "2026-10-12 22:17Z"
  },
  {
    "claim": "Signed-in views (member, operator, payee)",
    "evidence": "Signed-in `pnpm smoke` as the operator passed on dao `0d5964ea`: both agents open under the per-agent owner check, and the DAO's proposals read. The member and payee views, and the pages themselves, not re-checked",
    "when": "2026-10-14"
  },
  {
    "claim": "Typecheck, offline tests, web build",
    "evidence": "Local; tests use mocks, not the provider or chain",
    "when": "per release"
  },
  {
    "claim": "Every policy revision reproduces its hash, and the owner's grant and approval signatures verify",
    "evidence": "[Policy signatures and operation proofs](docs/mainnet-log.md#policy-signatures-and-operation-proofs-2026-10-13t0410z)",
    "when": "2026-10-13T04:10Z",
    "publicClaim": "Every policy revision reproduces its hash, and the owner's grant and approval signatures verify"
  },
  {
    "claim": "A person's wallet owns, grants and runs an agent; its autopilot swapped under the wallet's grant",
    "evidence": "[Wallet-owned agent](docs/mainnet-log.md#a-wallet-owned-agent-from-the-dashboard-2026-10-13t2126z); run locally, not through the hosted gateway",
    "when": "2026-10-13T21:26Z",
    "publicClaim": "A person's wallet owns, grants and runs an agent; its autopilot swapped under the wallet's grant"
  },
  {
    "claim": "DAO ownership: creation, grant, policy changes, freeze and held-payout approvals",
    "evidence": "Tested on mainnet with `agentic.sputnik-dao.near`: creating an agent, issuing a grant, changing its policy and freezing it, each by DAO vote (proposals #9 to #12). The freeze was filed from the dashboard through Trezu. Later, policy edits and the approvals of two held payouts were filed and voted the same way from the dashboard; both payouts settled (approvals #17 and #21, edits #20 and #22).",
    "when": "Historical README observation; UTC date and deployment were not recorded in that summary"
  },
  {
    "claim": "Through app access, a DAO sets up and creates a hosted Treasury agent, consents to an app, issues its strategy-bound grant and stops the agent, each by its own vote",
    "evidence": "[DAO through an app on staging](docs/mainnet-log.md#a-dao-owned-treasury-agent-through-an-app-on-platform-staging-2026-11-04-utc): `agentic.sputnik-dao.near`, proposals #59, #61, #62 and #63 plus the creation vote, platform staging deployment `bc635cb7`; funding and a DAO-approved proposal followed on 2026-11-05 (next row)",
    "when": "2026-11-04T22:19Z to 22:51Z"
  },
  {
    "claim": "Through app access, a DAO funds its hosted Treasury agent and approves an app's swap proposal by its own votes; the app executes it",
    "evidence": "[DAO funds and approves on staging](docs/mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc): `agentic.sputnik-dao.near`, proposals #64 (consent), #65 (funding, built by `fundingTransaction`) and #66 (approval), platform staging deployments `f417fc3a` and `3c085b20`; one swap `SUCCESS` above its signed floor",
    "when": "2026-11-05T03:19Z to 04:35Z"
  }
];

/** Public claim wording only; verification details stay in the member/documentation presentations. */
export const PROVEN: string[] = VERIFICATIONS.flatMap((row) => row.publicClaim ? [row.publicClaim] : []);
