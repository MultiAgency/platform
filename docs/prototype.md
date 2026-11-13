# The dashboard prototype

**Historical deployment and frontend.** The `dao` dashboard and `invoices` packages were the original agency experiment, run from this repository
before the headless platform host and `/apps/v1`. The owner dashboard frontend has been removed; the shared backend remains. Their hosted services were retired
and their packages are no longer built (2026-11-08). The platform's core loops are in the [README](../README.md#the-product). Gaps are in the README's
[Not done yet](../README.md#not-done-yet).

The sections below record historical prototype behavior; they are not current local dashboard instructions.

The [shared frontend integration](shared-frontend-integration.md) kept the prototype's own page as the static
three-idea showcase and served independently built Treasury and Payables frontends. Invoices was
Payables' payee-facing entry. The 2026-10-16 UTC [release record](archive/proto-release-execution.md)
records that release's sign-in, private access and routing checks.
Agents retain separate balances, authority and executors.
A new app builds on the platform through the [integration path](integration-path.md).

The initial agency experiment had two areas, each with its own agent owned by
`agentic.sputnik-dao.near`. Other owners reserve separate instances. Each area runs a brief from
the Agent Connect catalog and plans more:

| Area | What it shows | Details |
|---|---|---|
| **Payables** (Confidential Treasury Facilitator) | Anyone asks the DAO to be paid; agreements carry terms (contractor requests, work orders, bounty and grant awards); each payment is held for the DAO's vote and paid confidentially | [docs/facilitator.md](facilitator.md) |
| **Treasury** (Agentic Treasury Management) | An agent rebalances toward a target on its own, quoting every swap, inside per-asset caps and a USD budget the DAO signed; idle funds stay confidential | [docs/treasury.md](treasury.md) |

Each doc measures its briefs requirement by requirement (complete, tested, live) and lists what isn't covered.
The app shows the two running briefs and their evidence stages; additional roadmap briefs stay in those planning docs.

## Hosted demo (retired 2026-11-08)

The prototype's four public entry points ran on Railway until 2026-11-08, when the user deleted their services; they
no longer answer. They are described below as they ran. The owner dashboard build and browser suites have been removed. The retained supplier backend still runs with
`pnpm invoices`; the prototype packages are no longer built. What's hosted now is the platform host only: `api.dev.multiagency.ai` (staging) and `api.multiagency.ai`
(production), the headless `platform` package ([platform production](platform-production.md)). Signing in with a
NEAR wallet signs a message, never a transaction.

- **Dashboard**, https://proto.multiagency.ai: the existing treasury executor and payout approve-only instance.
  The public showcase links the three ideas; owner workspaces and guides require sign-in.
- **Treasury**, https://treasury.multiagency.ai: the independent Treasury frontend using the shared gateway.
- **Payables**, https://payables.multiagency.ai: the independent Payables frontend using the shared gateway.
- **Invoices**, https://invoices.multiagency.ai: payee routing to the existing payout executor,
  where payees request agreements, file invoices and follow their existing payment identities.
  Hosted sign-in, retained private access and payee page routing were checked in the
  [2026-10-16 UTC release](archive/proto-release-execution.md); no money action was performed.

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
Shared routing was deployed in the historical prototype release. New-owner provisioning and scoped payee journeys retain
offline coverage only; the release did not create an agent or issue a grant.

There are no public read-only walkthroughs or requirement cards at the entry. Legacy example hashes
also show sign-in when signed out. Requirement evidence remains in the canonical area documentation.
Hosts without walkthrough mode retain the existing workspace navigation and task pages.

See [frontend responsibilities](architecture.md#frontend-responsibilities-offline-tested) for
query, recovery and navigation behavior, [Payables](facilitator.md) and [Treasury](treasury.md)
for requirement evidence, and [DEMO.md](../DEMO.md) for the walkthrough.

Install the pinned browser once with `pnpm exec playwright install chromium`; `pnpm test:browser`
builds the app and runs the offline browser suites. These intercept requests and start no executor.
`pnpm test:e2e` additionally runs an isolated application stack with simulated provider, chain and wallet boundaries.
`pnpm verify` runs the complete offline verification sequence. See [test boundaries and harnesses](testing.md)
for credential isolation, live-test submission blocking, fixture contracts and failure artifacts.

Each agent in `deploy/dashboard.json` names its `owner`, and the gateway decides per agent who may see
it, from that owner at most a minute old. A wallet-owned agent admits only its owner account.
A Sputnik DAO's named group members may read private records. Their applicable Group and Everyone
permissions determine proposal and vote capabilities; public proposal rights alone never admit an outsider.
There is no configured operator list. Execution controls require both FunctionCall proposal and approval
permissions; local settings require both policy proposal and approval permissions. These are local
application permissions: they never replace the owner's signature, DAO approval threshold, signed policy
or live grant. The gateway and frontend share the same action checks. This mapping is offline-tested;
see [dashboard access](architecture.md#dashboard-access-offline-tested) for its exact scope.
With self-service enabled, a verified wallet without an agent may sign in to start setup, but gains no access to another owner’s agents. Walkthrough mode lists no agents while signed out. Hosts without these options retain the member-only sign-in behavior. None of this limits whoever runs the host, who can read every agent’s state there. Both hosted agents are owned by the DAO; a wallet-owned agent behind the
gateway is tested offline only (`test/gateway-denial.test.ts`). On the invoice page anyone may sign in, but only payees in
the payout agent's policy file invoices; anyone else files an agreement request.

The demo walkthrough is in [DEMO.md](../DEMO.md).

Deployment, executor migration and state preservation are documented in the
[operations guide](operations.md#dashboard). Each agent requires one executor host; the local
lease does not enforce that across machines. Other instances use `EXECUTOR=off`.

## Two kinds of agent

- A **treasury agent** swaps between USDC, wNEAR and ETH toward a target and shields anything public.
  Its experimental LLM steward (`/steward`) was removed in SDK 0.5.5. No vote per action.
- A **payout agent** only transfers USDC, confidentially, to payees the owner agreed to. Every payout
  waits for the owner's approval. Approval verification checks the intended terms against the current
  policy; cumulative enforcement and the final signed artifact retain the provider dependencies
  described in the [enforcement assessment](enforcement.md).

Each instance of the server runs one agent. To run a second beside the first, give it its own
settings file: `ENV_FILE=.env.payout PORT=8790 pnpm server`. It shares the API keys in `.env` but keeps
its own agent, grant and treasury, and each agent has its own action log in `.ops/`. The payout agent's
executor, which also serves the invoice page, starts with `ENV_FILE=.env.payout pnpm invoices`; any other
instance of an agent runs `EXECUTOR=off` ([operations](operations.md#payout-executor)).

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
grant, money lock and recovery loop. See [payout setup](operations.md#payout-executor).

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an **agreement request**, which is
never a payment. Agreements carry terms (an amount per invoice and a deadline), and the DAO can also
offer them first, as a service agreement or an award. Agreeing lists the payee in the policy by vote; the
payee then files the invoice, which is held for its own vote ([facilitator](facilitator.md)).
The hosted dashboard reads the invoice host's agreements with a shared secret (`AGREEMENTS_URL`,
`AGREEMENTS_SECRET`; [operations](operations.md#payout-executor)). Sign-in, storage, retries and
recovery are in [docs/architecture.md](architecture.md#invoice-storage).

**Work orders** use the same Payables workspace and invoice portal, with a dedicated agent for each
order. In Agreements, save one payee's fixed USDC amount, work description and deadline; authorize
its policy and expiring grant, then obtain a confidential USDC deposit address. Share its invoice link
with the payee. Payments also lists the order, its held payout and owner actions. Payment submission
always uses the original invoice identity and the shared dispatch path. This flow is locally implemented
and offline-tested; no work-order agent has been demonstrated on the deployed hosts.
