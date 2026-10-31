# MultiAgency shared infrastructure

This repository provides shared owner onboarding, isolated agent execution, host-bound access,
and payee intake for MultiAgency prototypes. Regular NEAR wallet owners and authorized Sputnik
DAO members can reserve their own Treasury or Payables setup; owner policy and grant signatures
remain separate. The public showcase reads no private records.

This repository is meant to be the one owner of the gateway, executor and money path, with apps building on it only
through `@multiagency/sdk`. Not yet: Payables and the Treasury prototype still carry their own copies (see Not done yet).

The [shared frontend integration](docs/shared-frontend-integration.md) keeps Proto as the static
three-idea showcase and serves independently built Treasury and Payables frontends. Invoices is
Payables' payee-facing entry. The 2026-10-16 UTC [release record](docs/proto-release-execution.md)
identifies the deployed artifact and verified sign-in, private access and routing boundaries.
Agents retain separate balances, authority and executors. [Source ownership and scope](docs/shared-backend-scope.md)
describe how this integration relates to the sibling Treasury and Payables directories.
A new prototype reuses the platform through the [integration path](docs/integration-path.md);
the [reuse map](docs/reuse-map.md) lists which platform pieces each existing workflow used (offline runs).


An AI agent manages a treasury on [NEAR Intents](https://near.org/intents) through the
[NEAR Intents Agent API](https://api.agentsonintents.com/llms.txt), inside a policy its owner signed.
The owner can be a person's wallet or a Sputnik DAO, such as a [Trezu](https://trezu.org) treasury.

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
| `pnpm run-report` | The unattended-run report ([operations](docs/operations.md#unattended-run-observing-the-treasury-autopilot)) |

## Hosted demo

Four public entry points share Railway routing. Signing in with a NEAR wallet signs a message, never a transaction.

- **Dashboard**, https://proto.multiagency.ai: the existing treasury executor and payout approve-only instance.
  The public showcase links the three ideas; owner workspaces and guides require sign-in.
- **Treasury**, https://treasury.multiagency.ai: the independent Treasury frontend using the shared gateway.
- **Payables**, https://payables.multiagency.ai: the independent Payables frontend using the shared gateway.
- **Invoices**, https://invoices.multiagency.ai: payee routing to the existing payout executor,
  where payees request agreements, file invoices and follow their existing payment identities.
  Hosted sign-in, retained private access and payee page routing were checked in the
  [2026-10-16 UTC release](docs/proto-release-execution.md); no money action was performed.

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

- `MultiAgency/payables` still carries its own copy of the gateway and money path, including
  `test/send-path.test.ts`, so a fix made here doesn't reach it. Its frontend calls the platform through the SDK but
  still imports modules from that copy, so the copy can't be retired yet. `MultiAgency/treasury-prototype` (not
  archived) still carries one too. The Treasury app (`MultiAgency/treasury`) is built on the SDK and is to replace the
  prototype and this platform's Treasury pages, which still run on the prototype's hosts.
- A new prototype must reuse a fixed host `demo` value and agent area. Owner-app `contract.json` is checked at
  runtime only on hosts served through the shared release server (offline E2E; not deployed). See the
  [integration path](docs/integration-path.md#gaps).
- Agent connections exist only for a contractor's own reports and are offline-tested and stack-tested, not deployed.
  A connection token is a bearer: whoever holds it can act within its permissions until it expires (at most 24 hours)
  or is revoked. Owner connections are not built. See [agent access](docs/agent-access.md#agent-connections-contractor-reports).
- App access (`/apps/v1`) covers reads, wallet-signed owner actions and payout requests (sent at most once per
  `requestId`): confidential USDC transfers, mainnet-observed on staging 2026-10-28 ([mainnet log](docs/mainnet-log.md));
  and withdrawals of wNEAR (arriving as native NEAR, per the provider's docs) or USDC to agreed NEAR accounts (USDC only
  to an account registered on the USDC contract, else refused before sending): USDC
  both mainnet-observed on staging 2026-10-30, paid without a vote, rejected when held, and the USDC refusal of an
  unregistered account ([mainnet log](docs/mainnet-log.md)). A held withdrawal can be rejected, not approved: its
  approval's hash is now observed, but approving one isn't built yet; so under the payout
  template, which holds every payout for the owner, a withdrawal is paid only once the owner turns that off
  ([enforcement](docs/enforcement.md)). Consents and hosted agent setup work for wallet-owned
  agents only; DAO consent and setup are not built. Hosted
  agents an app sets up belong to that deployment and Organization (one per owner and area), and nothing else reaches
  them; each is its own process, at most 32 per host, so many Organizations need more hosts. With `owner` scope an app
  receives an owner intent only when it is NEP-413 (a text the wallet can show); a NEP-366 one (creation, freeze, unfreeze,
  on-chain policy edits) reaches the app only as a link to the platform's confirm page, where the owner reads the
  agent's record and signs; the bytes go only to a visitor who first signs the link's readable text with the owner's
  key. A dishonest app that gets the owner to sign that text on its own page could still ask for a blind signature. Votes on
  held payouts can be relayed: the platform binds each to the held payout's provider evidence and returns its proven
  terms for the app to show; the vote's own text names no payee or amount, so that display is the only place the owner
  sees them. Whether each wallet shows NEP-413 text is not checked. These limits bind only the app route: an owner who signs the platform's sign-in text on an
  app's page gives that app a full platform session, which can send payouts within the signed policy without
  another signature. See [agent access](docs/agent-access.md#app-access-server-to-server). An app service
  credential is a bearer: whoever holds it acts within the consents owners gave that deployment until it expires or is
  revoked. See [agent access](docs/agent-access.md#app-access-server-to-server).
- A provider failure while preparing an owner action is reported as `unknown`: after a mutation, only a proven refusal
  keeps its code for the caller (`src/rpc/base.ts`). Preparing signs and sends nothing, so nothing moved; retrying
  prepares a new intent. Seen on staging 2026-10-30: an `owner_approval` edit failed once this way and succeeded on
  retry, with nothing recorded for the failure. Every failure that reaches a caller as `unknown` is now logged for the
  operator (`unclassified_error`: procedure, error class, throw site, and a provider error's status, code and request
  ID; never its message or detail), from source after 2026-10-30; the builds deployed on staging and production log
  nothing for it.
- A vote the platform's own checks refuse (for example approving a held withdrawal) reaches the app as `refused`, code
  `local_authorization_held`, from source after 2026-10-30 (offline- and stack-tested). The builds deployed on staging
  and production still answer `unknown` for it (seen on staging 2026-10-30), which there also means nothing reached the
  provider.
- Payables' frontend (`97ddec7`, re-checked 2026-10-16) passes the source contract preflight now that
  Proto serves `compensation`; this is a source-type check only. Its build is not yet exercised in the
  real-stack E2E suite, and owner-app builds are not checked for compatibility at runtime.
  See [consumer compatibility](docs/shared-frontend-integration.md#consumer-source-contract-preflight).

- A send whose provider reply is lost blocks its executor's later sends until reviewed, and no review procedure exists
  yet. Nothing is sent twice, and the payout stays approvable from the provider's history, but the block does not clear
  after settlement, and `pnpm reconcile` does not clear it. See [enforcement](docs/enforcement.md) (lost provider reply).

- FastNear deposit batching awaits a verified raw-transaction hash mapping; deployed indexer
  freshness remains unverified. Single-hash receipt reads remain in place. See the
  [infrastructure follow-up](docs/infrastructure-review.md#follow-up-review-2026-10-16).

- The shared-host infrastructure hardening is local, not deployed; see the
  [architecture review](docs/infrastructure-review.md) for failure reproductions, source provenance
  and remaining isolation/recovery limits. Coordinated [credential rotation](docs/credential-rotation.md)
  after the diagnostic exposure remains outstanding and requires owner-controlled maintenance.

- General live AG-UI agent orchestration is not implemented. Short-guide guidance is deterministic
  UI observation; the existing Treasury run recordings remain separate evidence.

- Multi-owner shared-host onboarding and scoped payee journeys remain offline-tested only. Complete hosted
  owner creation, grant issuance and payments for arbitrary wallet and DAO owners have not been
  observed on mainnet through this build. Payee conversion and forwarding remain unimplemented.


Self-service hosted creation is offline-tested only. Mainnet wallet and Trezu setup, capacity under load, and invoice intake for newly created Payables agents have not been demonstrated. Reservations are bounded to 32 instances; the cap is not abuse-resistant admission or distributed execution.

Work orders have no mainnet lifecycle evidence yet. Partial invoices, amendments, automatic residual-fund
return, automatic archival, and payee conversion/forwarding are not implemented. Work-order executors
run on one host, with a default capacity of eight; this is not distributed fencing. Exact invoice matching
and one retained payment identity are local checks, not provider guarantees of lifetime spending or
settlement by a deadline. See [operations](docs/operations.md#work-order-executors) before rollout.

The guided walkthroughs are locally implemented and tested with offline browser fixtures, not verified
on the deployed hosts. They depend on existing permissions, configured services and retained records;
they cannot guarantee a swap, immediate owner approval, or settlement.

Sweep covers managed USDC, wNEAR and ETH only; it does not establish that other assets are confidential.
Campaign winner identity and prize validation are not built. The local duplicate check covers only
a manual payout matching an existing held payout; provider replay deduplication remains unverified.

- The local auto-execute ceiling now sums and compares the decimal representations of individual
  numeric USD estimates exactly (offline-tested, not verified on the deployed hosts). Raw-amount
  conversion, individual valuations and the earlier plan-preview total still use floating-point
  arithmetic; their precision limitations remain. Provider-enforced policy caps and USD-budget
  accounting are unchanged; see [enforcement](docs/enforcement.md).

- Payment recovery reads and owner-action discovery are locally implemented and offline-tested, not
  verified on the deployed hosts. Recent payout discovery scans at most 250 provider records and
  filters to the past day; incomplete scans are explicit. Original terms depend on provider/local
  retention, and owner actions are discoverable only on the instance holding their durable records.
  The dashboard withholds repeat signing while a recorded action is prepared or submitted; this is
  not a new cross-instance lock or a stronger payment-settlement guarantee.
  During setup failure, read-only Activity depends on the gateway continuing to authorize access.
  Unverified ownership after a cold gateway restart remains denied; retained records are not fresh
  provider outcomes. Setup recovery is locally tested, not verified on deployed hosts.

- The inline Treasury strategy workflow is locally implemented and offline/browser-fixture tested,
  not deployed or mainnet-observed. Accounts with settings permission edit allocations and limits, save with the schedule off,
  and explicitly enable only after the owner authorizes the saved strategy. Server controls reject
  stale reviews; stop does not require provider availability and prevents future scheduled ticks. A tick
  already started can submit further operations; submitted operations may finish. Configuration coordination is single-host,
  not distributed fencing; direct file edits and provider changes after a read remain outside it.
- Prepared-invoice continuation is locally implemented and offline-tested (`test/invoice-http.test.ts`),
  but not yet verified on a deployed host. It reuses the authenticated payee’s stored terms and operation
  identity; revised or submission-attempted invoices are refused. It does not resolve unknown outcomes.

- Payee work-order selection now retains the selected order in the URL across reloads;
  **Check work orders** retries that exact record after an initial read failure
  (offline browser-tested, not deployed). An exact live owner-to-payee work-order journey
  and fresh payee-wallet sign-in remain unverified; see the
  [bounded journey check](docs/shared-frontend-integration.md#bounded-payables-journey-check--2026-10-16-utc).

- The AG-UI run-log adapter, private dashboard export and read-only recording inspector are offline-tested
  ([Treasury](docs/treasury.md#run-log-adapter-and-export-offline-tested)). The inspector steps through
  recorded observations, with each recorded stage's start and return grouped together and individual
  observations available on demand; it provides no timed playback or live stream. A missing stage
  return stays unknown even after a run end is recorded. New exports use envelope version 3 with
  AG-UI protocol 1.0 lifecycle validation: an unclosed stage or explicitly failed run ends with
  `RUN_ERROR`, not a fabricated stage completion. Versions 1/2 remain readable as legacy recordings.
  New ticks record intermediate
  stages and provider-accepted submissions for the polling run view; older ticks retain only their
  original evidence. See the [progress rollout](docs/operations.md#run-progress-rollout) before deployment.
  No real-recording or mainnet validation is claimed for these additions.

The [enforcement assessment](docs/enforcement.md#status) tracks the current evidence for the signed
spending envelope, including cumulative limits, policy binding and execution-artifact trust.
A provider `FAILED` status is currently treated as terminal locally; it is not independently verified
as proof that a replacement payment is safe. See [recovery guidance](DEMO.md#the-live-moment-one-invoice-end-to-end-facilitator).

- The API keeps signing requests open for 5 to 10 minutes, so a slow council misses the window.
- Trezu shows these proposals as a generic "sign on v1.signer", so a member voting there sees only a hash.
  The dashboard's "What am I voting on?" shows what each one does; check it there first.
- DAO delegate preparations sharing owner-intent storage on one host are serialized per owner and
  refuse while an earlier delegate submission is unresolved (offline-tested). Other hosts and signing
  clients are not coordinated; file those actions one at a time. See [enforcement](docs/enforcement.md).
- The policy's asset list limits what the agent spends, not what it buys: the wallet lets a swap into an
  unlisted asset through. This server refuses one before sending, but the wallet should enforce it.
- The owner can't verify the enforced policy: it is stored encrypted to the custody keystore, and the
  public `store_wallet_policy` takes no `agent_policy_hash`. The mandate digest is this server's own;
  the signed payload isn't shown to commit to it.
- Confidential credits from outside the API can't be attributed: nothing public indexes `intents.far`.
- A refusal says `policy_denied` without naming the rule that refused.
- An agent owned by a person's wallet was created and granted from a local dashboard on mainnet, and its
  autopilot then swapped under that grant on its own (2026-10-13, [mainnet log](docs/mainnet-log.md));
  behind the hosted gateway it is offline-tested only. Creating one signs a NEAR delegate
  action; the dashboard offers only the wallets HOT's near-connect list declares it for (today HOT, Meteor,
  Intear, Ledger and NEAR Mobile), read live; Meteor has signed through it so far.
- The owner's wallet picker loads HOT's near-connect wallet list from its `main` branch, unpinned, and each
  wallet's code from wherever that list points. The server checks every owner signature against what it
  prepared before relaying it, but a changed wallet could still phish for the owner's keys.
- Agreed terms (an amount per invoice and a deadline) are shown to voters beside each held payout;
  nothing refuses an invoice outside them.
- A DAO or other contract account can be paid, but can't ask to be paid on the invoice page: sign-in
  there needs a full-access key.
- The autopilot (off by default) hasn't yet run unattended for days. Outside the dashboard, its warnings
  reach the owner only through the optional Telegram notices (Notifications, above).

The signed-in `/demos` collection offers short guides for all three workflows. `/treasury`,
`/payables` and `/invoices` select an accessible agent for the corresponding complete walkthrough.
After selection, `/a/<instance>/demos/<workflow>` and `/a/<instance>/walkthrough/<workflow>` use the
same private action controls. Existing `/a/<instance>/demo` links remain valid. Full-app links point
to the dedicated product domains. Opening, switching versions or reloading submits nothing.

Short guides consume validated AG-UI CUSTOM events projected from UI observations. Guidance is
currently deterministic, not LLM-directed, and is not an executor run log or settlement evidence.
Exact selected plan/payment identities remain in the existing outcome views; no selection is
inferred after reload. Work-order guides use the existing per-order controls and retained identities.
Live AG-UI agent orchestration across all three workflows remains unimplemented. Treasury run
recordings retain their separate evidence-backed AG-UI format.
