# MultiAgency platform

Control plane for agentic treasuries, built on NEAR Intents.

An AI agent manages a treasury on [NEAR Intents](https://near.org/intents) through the
[NEAR Intents Agent API](https://api.agentsonintents.com/llms.txt), inside a policy its owner signed.
The owner can be a person's wallet or a Sputnik DAO, such as a [Trezu](https://trezu.org) treasury.
The provider holds the funds and enforces that policy. This platform adds what the provider can't: owner sign-in and
consent, checks before each send, at-most-once execution with recovery, and owner and DAO approvals
([enforcement](docs/enforcement.md) says how each is known). Regular NEAR wallet
owners and authorized Sputnik DAO members can reserve their own Treasury or Payables setup; owner policy and grant
signatures remain separate. The public showcase reads no private records.

This repository is meant to be the one owner of the gateway, executor and money path, with apps (Treasury, Payables,
Invoices, the MultiAgency dashboard) building on it only through `@multiagency/sdk`. Not yet: Payables and the Treasury
prototype still carry their own copies (see Not done yet).

The [shared frontend integration](docs/shared-frontend-integration.md) keeps the platform's own page as the static
three-idea showcase and serves independently built Treasury and Payables frontends. Invoices is
Payables' payee-facing entry. The 2026-10-16 UTC [release record](docs/archive/proto-release-execution.md)
records that release's sign-in, private access and routing checks.
Agents retain separate balances, authority and executors.
A new app builds on the platform through the [integration path](docs/integration-path.md).

> Runs on NEAR mainnet with real funds. Use a low-value account and small amounts.

The initial agency experiment has two areas, each with its own agent owned by
`agentic.sputnik-dao.near`. Other owners reserve separate instances. Each area runs a brief from
the Agent Connect catalog and plans more:

| Area | What it shows | Details |
|---|---|---|
| **Payables** (Confidential Treasury Facilitator) | Anyone asks the DAO to be paid; agreements carry terms (contractor requests, work orders, bounty and grant awards); each payment is held for the DAO's vote and paid confidentially | [docs/facilitator.md](docs/facilitator.md) |
| **Treasury** (Agentic Treasury Management) | An agent rebalances toward a target on its own, quoting every swap, inside per-asset caps and a USD budget the DAO signed; idle funds stay confidential | [docs/treasury.md](docs/treasury.md) |

Each doc measures its briefs requirement by requirement (complete, tested, live) and lists what isn't covered.
The app shows the two running briefs and their evidence stages; additional roadmap briefs stay in those planning docs.

## How it works

- The **owner** signs a **policy**: allowed actions, assets, caps, budget, and where funds may go.
- The owner issues a **grant** that lets this server act for the **agent** inside that policy.
- The agent swaps, shields and pays through the Agent API and OutLayer, with application checks and
  provider-enforced limits. Output-asset enforcement is local; strict cumulative per-asset enforcement
  and USD-budget atomicity remain unproven. See the [enforcement assessment](docs/enforcement.md) for
  the evidence and remaining gaps.
- Every policy has a **mandate digest**: sha256 of its canonical JSON (`src/mandate.ts`), which anyone
  holding the policy can recompute. Every plan and every money action records the digest it ran under.
- The **books** compare public balances against the chain's
  `intents.near` transfers (FastNear's Transfers API), confidential ones against the API's recorded
  executions. Differences are unexplained: external credits, incomplete records or observation timing
  can cause them. This is not independent proof of confidential custody. `pnpm books` prints them,
  and `pnpm books --csv` exports the ledger.

How the money path keeps these safe (one send site, the journal, reconciliation, owner intents, invoice
storage and the checks before each send) is in [docs/architecture.md](docs/architecture.md#how-the-money-path-stays-safe-on-one-host).

## Run it

```sh
pnpm install
cp .env.example .env   # add an API key from https://partners.demo.agentsonintents.com
pnpm demo              # dashboard on http://localhost:8787
```

The dashboard walks you through creating an agent and issuing its grant, and runs every money action.
The command line has only what the dashboard doesn't: owner actions signed with a local key, and checks.

| Owner actions, signed with `AGENT_OWNER_PRIVATE_KEY` instead of a wallet or DAO vote | |
|---|---|
| `pnpm create-agent` | Creates an agent with the policy in `src/policy.ts` and saves `AGENT_ID` |
| `pnpm issue-grant [treasury\|payout\|invoices] [suffix]` | Issues a grant and saves its token |
| `pnpm revoke-grant [grant id]` | Lists live grants, or revokes one |
| `pnpm update-policy [--policy file] [--diff]` | Prints the change from the policy in force, then signs it without asking; `--diff` only prints |
| `pnpm archive` | Freezes, then archives the agent (reversible) |

| Checks | |
|---|---|
| `pnpm inspect [--whoami]` | The agent's policy, balances and grants, as the API returns them |
| `pnpm reconcile [--poll]` | Operations without a proven outcome; `--poll` reads their statuses once, resending nothing |
| `pnpm books [--csv]` | Balances against chain transfers and recorded executions; `--csv` prints the ledger |
| `pnpm smoke` | Read-only check of the hosted dashboard and invoice page |
| `pnpm run-report` | The unattended-run report ([unattended run](docs/unattended-run.md)) |

## Hosted demo

Four public entry points share Railway routing. Signing in with a NEAR wallet signs a message, never a transaction.

- **Dashboard**, https://proto.multiagency.ai: the existing treasury executor and payout approve-only instance.
  The public showcase links the three ideas; owner workspaces and guides require sign-in.
- **Treasury**, https://treasury.multiagency.ai: the independent Treasury frontend using the shared gateway.
- **Payables**, https://payables.multiagency.ai: the independent Payables frontend using the shared gateway.
- **Invoices**, https://invoices.multiagency.ai: payee routing to the existing payout executor,
  where payees request agreements, file invoices and follow their existing payment identities.
  Hosted sign-in, retained private access and payee page routing were checked in the
  [2026-10-16 UTC release](docs/archive/proto-release-execution.md); no money action was performed.

With `walkthroughs: true` or `selfService: true`, the signed-in entry is **Your agents**. Choose an existing
agent or **Create your own agent**, select Portfolio or Payables, and continue setup. A regular NEAR
wallet owns its own agent. For a DAO, sign in with a member's wallet, then select the DAO through
Trezu; the gateway verifies membership and permission to propose owner actions. Owner signatures,
DAO votes, policy application, grants and funding remain separate steps.

Self-service setup (`selfService: true`) reserves one instance per owner and area, up to 32 on this
host. Retrying reopens the same reservation. The selected owner and area cannot be changed inside
that setup. Each instance retains its own settings, grant, lease and records; reservation itself
sends nothing to the provider. The agent's policy is still created through the existing owner-intent
flow. Provisioning and ownership isolation are tested offline, not mainnet-observed.

**Open agent** opens its task workspace at `/a/<instance>/workspace`, or resumes incomplete setup.
Policy and grants, funding, activity and guided walkthroughs have separate agent-scoped links.
The **Guided walkthrough** link opens the real rebalance or payment controls. The guide summarizes
prerequisite observations and follows the exact confirmed plan or returned payment. Funding,
policy, grants, agreements and Activity remain linked where needed. Unknown outcomes remain
unresolved; approval does not establish settlement. Opening or reloading a guide submits nothing.
When a payee host is configured, owner-created Payables agents receive an isolated payee entry
at `/i/<instance>/` after provider agent creation. The existing approve-only payout agent retains its
separate invoice executor. New owner-created agents never share that executor’s state or grant.
The shared routing is deployed. New-owner provisioning and scoped payee journeys retain
offline coverage only; the release did not create an agent or issue a grant.

There are no public read-only walkthroughs or requirement cards at the entry. Legacy example hashes
also show sign-in when signed out. Requirement evidence remains in the canonical area documentation.
Hosts without walkthrough mode retain the existing workspace navigation and task pages.

See [frontend responsibilities](docs/architecture.md#frontend-responsibilities-offline-tested) for
query, recovery and navigation behavior, [Payables](docs/facilitator.md) and [Treasury](docs/treasury.md)
for requirement evidence, and [DEMO.md](DEMO.md) for the walkthrough.

Install the pinned browser once with `pnpm exec playwright install chromium`; `pnpm test:browser`
builds the app and runs the offline browser suites. These intercept requests and start no executor.
`pnpm test:e2e` additionally runs an isolated application stack with simulated provider, chain and wallet boundaries.
`pnpm verify` runs the complete offline verification sequence. See [test boundaries and harnesses](docs/testing.md)
for credential isolation, live-test submission blocking, fixture contracts and failure artifacts.

Each agent in `deploy/dashboard.json` names its `owner`, and the gateway decides per agent who may see
it, from that owner at most a minute old. A wallet-owned agent admits only its owner account.
A Sputnik DAO's named group members may read private records. Their applicable Group and Everyone
permissions determine proposal and vote capabilities; public proposal rights alone never admit an outsider.
There is no configured operator list. Execution controls require both FunctionCall proposal and approval
permissions; local settings require both policy proposal and approval permissions. These are local
application permissions: they never replace the owner's signature, DAO approval threshold, signed policy
or live grant. The gateway and frontend share the same action checks. This mapping is offline-tested;
see [dashboard access](docs/architecture.md#dashboard-access-offline-tested) for its exact scope.
With self-service enabled, a verified wallet without an agent may sign in to start setup, but gains no access to another owner’s agents. Walkthrough mode lists no agents while signed out. Hosts without these options retain the member-only sign-in behavior. None of this limits whoever runs the host, who can read every agent’s state there. Both hosted agents are owned by the DAO; a wallet-owned agent behind the
gateway is tested offline only (`test/gateway-denial.test.ts`). On the invoice page anyone may sign in, but only payees in
the payout agent's policy file invoices; anyone else files an agreement request.

The demo walkthrough is in [DEMO.md](DEMO.md).

Deployment, executor migration and state preservation are documented in the
[operations guide](docs/operations.md#dashboard). Each agent requires one executor host; the local
lease does not enforce that across machines. Other instances use `EXECUTOR=off`.

## Two kinds of agent

- A **treasury agent** swaps between USDC, wNEAR and ETH toward a target, shields anything public,
  and, as an experiment reached only at `/steward`, can be steered by an LLM whose responses are verified
  against its TEE. No vote per action.
- A **payout agent** only transfers USDC, confidentially, to payees the owner agreed to. Every payout
  waits for the owner's approval. Approval verification checks the intended terms against the current
  policy; cumulative enforcement and the final signed artifact retain the provider dependencies
  described in the [enforcement assessment](docs/enforcement.md).

Each instance of the server runs one agent. To run a second beside the first, give it its own
settings file: `ENV_FILE=.env.payout PORT=8790 pnpm server`. It shares the API keys in `.env` but keeps
its own agent, grant and treasury, and each agent has its own action log in `.ops/`. The payout agent's
executor, which also serves the invoice page, starts with `ENV_FILE=.env.payout pnpm invoices`; any other
instance of an agent runs `EXECUTOR=off` ([operations](docs/operations.md#payout-executor)).

## Notifications

Each executor can tell the owner on Telegram when something waits for a person: a payment held for
approval, a money action still without a proven outcome after about five minutes (sends are paused
until it's reconciled; one merely in flight settles sooner), or the autopilot's open warnings and
decisions. It reads only the executor's own state, once a minute, and announces each item once while it
stays open, across restarts too (`src/notify.ts`). Messages name the agent and link to the page where the
owner acts on the item; they never carry amounts, payees or balances, since Telegram sees them.
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (and optionally `NOTIFY_NAME`, `NOTIFY_LINK`) on the
executor's service; without them it does nothing.

## Invoices

The payout executor serves both the private dashboard and public invoice page through the same
grant, money lock and recovery loop. See [payout setup](docs/operations.md#payout-executor).

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an **agreement request**, which is
never a payment. Agreements carry terms (an amount per invoice and a deadline), and the DAO can also
offer them first, as a service agreement or an award. Agreeing lists the payee in the policy by vote; the
payee then files the invoice, which is held for its own vote ([facilitator](docs/facilitator.md)).
The hosted dashboard reads the invoice host's agreements with a shared secret (`AGREEMENTS_URL`,
`AGREEMENTS_SECRET`; [operations](docs/operations.md#payout-executor)). Sign-in, storage, retries and
recovery are in [docs/architecture.md](docs/architecture.md#invoice-storage).

**Work orders** use the same Payables workspace and invoice portal, with a dedicated agent for each
order. In Agreements, save one payee's fixed USDC amount, work description and deadline; authorize
its policy and expiring grant, then obtain a confidential USDC deposit address. Share its invoice link
with the payee. Payments also lists the order, its held payout and owner actions. Payment submission
always uses the original invoice identity and the shared dispatch path. This flow is locally implemented
and offline-tested; no work-order agent has been demonstrated on the deployed hosts.

## DAO ownership

A DAO has no keys, but it can sign through NEAR's MPC network. The owner is an account whose only
key is derived from the DAO, so every owner action becomes a DAO proposal calling `v1.signer.sign`.
When the vote passes, the server picks up the signature and submits it. The Agent API needs no
changes. See `src/dao-owner.ts`.

The recorded DAO ownership checks and their evidence limits are in the
[demo verification table](DEMO.md#what-is-verified).

A confidential Trezu treasury funds its agent with a payment from its confidential balance to
`nearcom:<the agent's wallet account>`, which the Funding page links to. Without the `nearcom:`
prefix, Trezu sends the payment out as a public withdrawal.

## Mainnet evidence

Each area's doc maps every claim to how it is known: [Payables](docs/facilitator.md),
[Treasury](docs/treasury.md). Every dated mainnet run, with its DAO proposal numbers, is in
[docs/mainnet-log.md](docs/mainnet-log.md). Operation ids and amounts are kept in a private record, since the
treasury is confidential; they are available to reviewers on request.

The app and the area tables use one [canonical requirement/evidence inventory](evidence/inventory.ts).
Historical deployment checks and their limits are in the generated
[demo verification table](DEMO.md#what-is-verified). Edit the inventory, then run
`pnpm evidence:write`; `pnpm evidence:check` and `pnpm test` reject stale generated sections.
Record new mainnet observations in [the dated log](docs/mainnet-log.md), then reference that evidence
in the inventory. Keep private release details out of both. Walkthroughs link to these records instead
of maintaining separate requirement statuses.

## Not done yet

Each line is a gap; the linked page says how the rest is known. The
[enforcement assessment](docs/enforcement.md#status) tracks the signed spending envelope.

**Apps and the platform**
- `MultiAgency/payables` and `MultiAgency/treasury-prototype` (not archived) still carry their own copies of the
  gateway and money path, so a fix here doesn't reach them; Payables' frontend still imports from its copy. The
  Treasury app (`MultiAgency/treasury`) is to replace the prototype and this platform's Treasury pages.
- A new prototype must reuse a fixed host `demo` value and agent area; owner-app `contract.json` is checked at runtime
  only on hosts served by the shared release server (offline E2E, not deployed). See the
  [integration path](docs/integration-path.md#gaps).
- Payables' frontend (`97ddec7`, 2026-10-16) passes the source contract preflight only; its build isn't in the
  real-stack E2E suite. See
  [consumer compatibility](docs/shared-frontend-integration.md#consumer-source-contract-preflight).
- App access (`/apps/v1`) isn't in production. Mainnet-observed on staging: confidential USDC payouts (2026-10-28) and
  withdrawals of wNEAR or USDC to agreed NEAR accounts (2026-10-30) ([mainnet log](docs/mainnet-log.md)). Wallet-owned
  agents only on staging; a held withdrawal can be rejected, not approved, so under the payout template it is paid only once the
  owner turns approval off; at most 32 hosted agents per host. A dishonest app can still get a blind NEP-366 signature
  by having the owner sign the confirm link's text on its own page; a held payout's vote text names no payee or amount,
  so the app's display is the only place the owner sees them; an owner who signs the platform's sign-in text on an
  app's page gives it a full session; a service credential is a bearer. See [app access](docs/app-access.md).
- Treasury proposals (`treasury`, `treasury-execute`) are offline- and stack-tested only, and the platform host
  doesn't set up Treasury agents yet. A proposal's approval is the platform's check, not the provider's: whoever holds
  the treasury grant can swap within the policy without it. Held swaps aren't used: what their vote commits to is
  unobserved ([enforcement](docs/enforcement.md#treasury-proposals-offline--and-stack-tested)).
- DAO-owned agents through apps: consent, Treasury proposal votes, the grant, freeze and unfreeze by DAO vote are
  offline- and stack-tested only (simulated DAO votes; no host, not mainnet-observed). DAO setup through an app isn't
  built, and the provider's owner intents (grant, freeze) expire in minutes, so only a DAO whose vote passes that fast
  completes them. See [app access](docs/app-access.md).
- Agent connections exist only for a contractor's own reports (offline- and stack-tested, not deployed); a token is a
  bearer for at most 24 hours; owner connections aren't built. See
  [agent access](docs/agent-access.md#agent-connections-contractor-reports).
- A provider failure while preparing an owner action reaches the caller as `unknown`; nothing was signed or sent, and
  retrying prepares a new intent (seen on staging 2026-10-30). The deployed staging and production builds predate two
  source changes after 2026-10-30 ([errors at the RPC boundary](docs/architecture.md#errors-at-the-rpc-boundary)): there
  a vote the platform's own checks refuse answers `unknown`, not `refused` (`local_authorization_held`), and a failure
  that reaches a caller as `unknown` isn't logged (`unclassified_error`).

**Money path and recovery**
- A send whose provider reply is lost blocks its executor's later sends, with no review procedure yet; nothing is sent
  twice, but the block doesn't clear after settlement or with `pnpm reconcile` ([enforcement](docs/enforcement.md)).
- A provider `FAILED` status is treated as terminal; it isn't verified to make a replacement payment safe
  ([recovery guidance](DEMO.md#the-live-moment-one-invoice-end-to-end-facilitator)).
- Payment recovery reads and owner-action discovery are offline-tested only. Discovery scans at most 250 provider
  records from the past day (an incomplete scan says so); original terms depend on provider and local retention; owner
  actions are found only on the instance holding their records; the dashboard's repeat-signing guard is not a
  cross-instance lock. Unverified ownership after a cold gateway restart stays denied.
- Prepared-invoice continuation is offline-tested (`test/invoice-http.test.ts`), not on a deployed host; it refuses
  revised or submission-attempted invoices and doesn't resolve unknown outcomes.
- The local duplicate check covers only a manual payout matching a held one; provider replay deduplication is
  unverified.
- The auto-execute ceiling compares exact decimal sums; raw-amount conversion, valuations and the plan-preview total
  still use floating point. Provider caps and the USD budget are unaffected.

**Policy and provider**
- The policy's asset list limits what the agent spends, not what it buys: the wallet lets a swap into an unlisted
  asset through. This server refuses one before sending; the wallet should.
- The owner can't verify the enforced policy: it is stored encrypted to the custody keystore, and the public
  `store_wallet_policy` takes no `agent_policy_hash`. The mandate digest is this server's own.
- A refusal says `policy_denied` without naming the rule. Confidential credits from outside the API can't be
  attributed: nothing public indexes `intents.far`.
- Signing requests stay open 5 to 10 minutes, so a slow council misses the window. Trezu shows these proposals as a
  generic "sign on v1.signer"; the dashboard's "What am I voting on?" shows what each does.
- DAO delegate preparations are serialized per owner on one host only (offline-tested); file them one at a time.

**Owners, wallets and payees**
- A wallet-owned agent was created, granted and swapped on its own from a local dashboard on mainnet (2026-10-13,
  [mainnet log](docs/mainnet-log.md)); behind the hosted gateway it is offline-tested only. The dashboard offers the
  wallets HOT's near-connect list declares for delegate signing (today HOT, Meteor, Intear, Ledger and NEAR Mobile);
  Meteor has signed so far.
- The wallet picker loads that list from its `main` branch, unpinned, and each wallet's code from where it points. The
  server checks every owner signature before relaying it, but a changed wallet could phish for keys.
- Agreed terms (an amount per invoice and a deadline) are shown to voters beside each held payout; nothing refuses an
  invoice outside them. A DAO or other contract account can be paid but can't ask to be paid on the invoice page
  (sign-in there needs a full-access key).
- Multi-owner hosted onboarding, scoped payee journeys and self-service hosted creation are offline-tested only:
  hosted creation, grants and payments for arbitrary wallet and DAO owners, Trezu setup, capacity under load and
  invoice intake for new Payables agents aren't observed. The 32-instance cap isn't abuse-resistant admission. Payee
  conversion and forwarding aren't built.
- Work orders have no mainnet lifecycle yet; partial invoices, amendments, automatic residual return and archival
  aren't built; executors run on one host, eight by default. Exact invoice matching and one payment identity are
  local checks, not provider guarantees. See [operations](docs/operations.md#work-order-executors). The live
  owner-to-payee work-order journey and fresh payee sign-in are unverified
  ([bounded journey check](docs/shared-frontend-integration.md#bounded-payables-journey-check--2026-10-16-utc)).
- Campaign winner identity and prize validation aren't built.

**Treasury**
- The autopilot (off by default) hasn't run unattended for days; outside the dashboard its warnings reach the owner
  only through the optional Telegram notices.
- The inline strategy workflow is offline- and browser-fixture-tested only. Stop prevents future ticks, but a tick
  already started can still submit; configuration coordination is single-host.
- Sweep covers managed USDC, wNEAR and ETH only.
- The run-log adapter, export and recording inspector are offline-tested, with no timed playback, live stream or
  real-recording validation
  ([Treasury](docs/treasury.md#run-log-adapter-and-export-offline-tested),
  [progress rollout](docs/operations.md#run-progress-rollout)).

**Infrastructure and walkthroughs**
- The shared-host hardening is local, not deployed ([architecture review](docs/archive/infrastructure-review.md)), and
  the coordinated [credential rotation](docs/credential-rotation.md) after the diagnostic exposure is outstanding.
- FastNear deposit batching awaits a verified raw-transaction hash mapping; deployed indexer freshness is unverified
  ([follow-up](docs/archive/infrastructure-review.md#follow-up-review-2026-10-16)).
- Guided walkthroughs and short guides (`/demos`) are tested with offline browser fixtures, not on the deployed hosts,
  and can't guarantee a swap, prompt approval or settlement. Guidance is deterministic, not an LLM; live AG-UI agent
  orchestration isn't built.
