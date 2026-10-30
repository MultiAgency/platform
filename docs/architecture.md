# Architecture

The [2026-10-16 shared-host review](infrastructure-review.md) records local gateway supervision,
transport and error-boundary fixes, their offline reproductions, repository ownership and remaining
limitations. These changes are not deployed. The [credential rotation procedure](credential-rotation.md)
remains an owner-controlled production gate.

Two areas, Payables and Treasury, share one core. Each agent runs in its own instance of the server (`src/server.ts`),
with its own wallet, grant, money lock and logs; the hosted gateway signs members in and forwards
their calls to those instances. Files are listed under `src/` unless a path says otherwise.

Work orders add private subprocesses on the invoice executor host, one per order. They expose no
network listener and inherit infrastructure credentials but no parent grant or owner signing key.
They share the host's filesystem permissions; this is not an OS security sandbox.
`work-orders.ts` and `rpc/work-orders.ts` bind owner requests to the configured payout agent;
the approve-only dashboard uses the secret-protected `/internal/work-orders` bridge. Payee routes
authenticate the payee before selecting an order and never accept an agent, amount or recipient
override. `work-order-runtime.ts` reuses owner intents, invoice storage and reconciliation.

`work-order-binding.ts` checks the fixed invoice identity, terms, deadline, grant expiry and policy
digest after dispatch's final provider observations, synchronously before submission. The existing
`authorize.ts` rules are unchanged by this feature. A refused binding is recorded as
`work_order_binding`; an unknown outcome retains the original invoice and blocks new sends.
These are local application restrictions. The provider separately enforces its policy and grant.
Offline tests cover the binding, authenticated HTTP routes, private processes and restart identity;
no work-order lifecycle has been observed on mainnet.

## The one rule

**One send site.** Every money action, whichever area starts it, goes through `dispatch` in
`agent.ts`: under the money lock, with no unresolved operation, a write-ahead record, `authorize`, then
the provider call. Before the record, a transfer's named recipient must exist on NEAR (`recipients.ts`, read at final
finality): otherwise it is refused `recipient_not_found`, or `recipient_unchecked` when the chain didn't answer, with
nothing recorded or sent. NEAR Intents credits any id, and the provider's own refusal would arrive after the send claim,
where this server can't yet prove nothing moved. Implicit ids need no account and aren't read. A withdrawal of an asset a payout
may withdraw, other than wNEAR (arriving as native NEAR), also needs its recipient registered on the token contract,
else `recipient_not_registered`, since such a delivery fails per the NEAR Intents docs. `test/send-path.test.ts` fails if any other file sends. The callers are
`invoices.ts` (an invoice's payment), `payout-requests.ts` (a payout an app or owner asks for under its own
`requestId`), `treasury.ts` and `plans.ts` (shields, swaps, sweeps) and `agent.ts`'s own `pay` (a payment by hand).

## Shared core

`src/router.ts` composes `rpc/owner.ts`, `rpc/payables.ts`, `rpc/treasury.ts` and
`rpc/observations.ts`. Shared transport error handling lives in `rpc/base.ts`; shared input schemas
live in `rpc/inputs.ts`. This extraction retains procedure paths, gateway access classifications and
existing domain calls. Submission remains centralized in dispatch.

| Concern | Files |
|---|---|
| Sending | `agent.ts` (dispatch), `authorize.ts` (checks the provider can't make; pure), `lock.ts`, `executor-lease.ts`, `executor-lifecycle.ts` |
| Records | `ops.ts` (the operation journal), `recover.ts`, `reconcile.ts`, `synced.ts`, `evidence.ts`, `inbox.ts` |
| The owner's rules | `policy.ts`, `mandate.ts` (the digest), `grants.ts`, `owner-intents.ts`, `owner-requests.ts`, `owner.ts`, `dao-owner.ts`, `nep413.ts`, `chain.ts` |
| Provider and values | `api.ts`, `holdings.ts`, `value.ts`, `ledger.ts` |
| Serving | `server.ts`, `router.ts`, `http.ts`, `signin.ts`, `env.ts`, `notify.ts` |

## Confidential Treasury Facilitator (the payout agent)

| Concern | Files |
|---|---|
| Intake | `invoice-http.ts` (public routes, `/internal/agreements`), `invoice-page.ts` (HTML and copy), `invoice-browser.js` (checked browser module), `agreements.ts` (requests, offers, terms), `invoices-server.ts` |
| Payments | `invoices.ts` (files an invoice through dispatch), `invoice-store.ts` (SQLite: identity, revisions, reservations), `payouts.ts` (held payouts), `payout-requests.ts` (payout requests: the operation's key derived from the caller and `requestId`, sent once, answered by `requestId`) |
| Approval | `payment-approval.ts` (checks a held payout against provider evidence before the owner signs) |

## Agentic Treasury Management (the treasury agent)

| Concern | Files |
|---|---|
| Planning | `treasury.ts` (rebalance legs, quotes, sweep), `planning/` (plan model, checks, storage, observations and execution; `plans.ts` retains compatibility exports), `strategy.ts`, `strategy-digest.ts` |
| Running alone | `autopilot.ts` (the scheduled tick: sweep, then rebalance within its limit) |
| Experimental | `llm.ts` (the steward, reached only at `/steward`) |

## Around them

- **Gateway** (`gateway/`): sign-in decided per agent from its owner (`roles.ts`): a DAO's roles, or the
  owner account itself; which calls each role may
  make (`allowlist.ts`), and, for members, proposal decoding for "What am I voting on?" (`proposals.ts`, `sign-requests.ts`).
  App access (`app-access.ts`, `app-routes.ts`) serves `/apps/v1` to app servers; `app-confirm.ts` holds the NEP-366
  owner actions apps prepare and serves the confirm page's two calls.
- **Web** (`web/src/`): one app for both areas, plus the standalone confirm page (`confirm.tsx`, its own build entry). `format.ts` `kindOf` uses the configured area, with a policy-based fallback for legacy instances; `beats.ts` holds each area's briefs, requirements and stages; `showcase.tsx` shows
  them. `timeline-payment.tsx` and `timeline-run.tsx` follow one held payment or the latest autopilot
  run step by step, each step read from its own record; they show data only on the instance that holds
  those records (approvals filed there, evidence its executor wrote).
- **Packages**: every release candidate builds two from the same tested snapshot. `dao`
  (`scripts/package-shared-frontends.mjs`) is the prototype's full deployment: gateway, owner app, demo hosts and the
  bundled Treasury and Payables frontends. `platform` (`scripts/package-platform.mjs`) is the engine for apps: the
  gateway as a headless host (`headless` in its config: `/health`, `/apps/v1` and the confirm page only, app setup per
  `appSetup`) and the confirm entry's files alone, each byte-equal to the tested build's. Hosted agents run the same
  agent server in both. Both share `scripts/release-package.mjs` (copy, file hashes, manifest).
- **Command line**: `create-agent.ts`, `issue-grant.ts`, `revoke-grant.ts`, `update-policy.ts`,
  `archive.ts`, `inspect.ts`, `books.ts`, `smoke.ts`, `run-report.ts`, `report.ts`, `remote.ts`.

Planning is grouped under `src/planning/`: `model.ts` defines the saved contract, `checks.ts` is pure,
`store.ts` preserves the existing `.plans/` format and claims, `observation.ts` reads current facts,
and `execution.ts` coordinates execution. Treasury previews import storage and observations directly,
so planning and execution no longer form a runtime import cycle. `src/plans.ts` keeps existing imports
compatible. The source digest changes with this extraction; state paths, saved plan digests and the
single send site do not. Existing execution/recovery tests and `test/planning-boundaries.test.ts`
cover this locally; it does not establish new mainnet behavior.
Other domain-wide file moves remain separate changes because they touch nearly every import.

## How the money path stays safe on one host

The provider enforces the signed policy; what that guarantees is in [enforcement](enforcement.md). This
is what the server adds around it.

### Sends, journal and recovery

New money actions recheck lock ownership and unresolved operations after
preflight. This closes the reproduced preflight lock-loss scenario; ownership loss during an
in-flight send remains a single-host residual risk, not a distributed fencing guarantee.

Owner intents persist `prepared → submitted → settled` in a private per-instance file. Updates take
an inter-process lock and reload the file before modification, so concurrent preparation and settlement
preserve each other's records. `submitted` means submission was attempted, not proven accepted.
Own and peer readers refuse malformed lifecycle states or an unsigned preparation containing a
retained signature or outcome; those records need verified recovery, not another submission.
The local reader refuses settled records without a recognized terminal outcome. Peer records with
incomplete settlement evidence continue blocking another delegate preparation.
A browser wallet's signature is relayed only if it is the owner's key, as the API names it, over exactly
the prepared intent: the NEP-413 message, or a NEP-366 delegate action from the owner's account calling
exactly the prepared methods, arguments, gas and deposits (`src/owner-signature.ts`). The wallet's own
code loads from outside this repo, so this doesn't rest on the API's check. Offline-tested, and passed
by a browser wallet's delegate action and message signature on mainnet (2026-10-13, mainnet log); a
tampered signature hasn't been seen live. A wallet that adds a `callbackUrl` to a NEP-413 signature is
refused, safe but possibly too strict for some wallets. A DAO's signature is found on chain and
verified against the prepared hash (`findSignature` in `src/dao-owner.ts`) before it is submitted.
Approval signatures are poll-only after an attempt. For other owner actions, the existing recovery
flow can resend the saved signature only while the API reports `PENDING_SIGNATURE` and the signing
window remains open. Settled results remain available after restart. Records deleted by older versions
cannot be reconstructed locally. This is single-host coordination, not distributed fencing.

The agent's executor runs status-only reconciliation every 10 seconds (an `EXECUTOR=off` instance doesn't), independently of strategy execution.
Startup and successful onboarding use one activation path: acquire the single-host executor lease
before publishing a new agent identity, then start the background loops once. Failed ownership
acquisition leaves the original creation action available for recovery without signing again.
Approve-only activation also binds one identity; shutdown prevents a late lease acquisition from
publishing an identity or starting background loops.
`pnpm reconcile --poll` performs one pass. Unknown IDs, failed reads, `UNCERTAIN`, and `NEEDS_REVIEW`
remain unresolved. Nothing is resent: provider deduplication and lookup semantics remain unverified.

Plans simulate cumulative swaps and shields using guaranteed output floors, then recheck remaining
feasibility between legs. Policy, strategy digest, cost ceiling, and expiry are checked after
asynchronous preflight before each send, including a swap following an automatic shield.
These recovery and execution checks are offline fault-tested; they are not mainnet-validated.

New non-invoice operations use journal v2: a durable preparation followed by a durable submission
claim before the provider call. On the next money-lock acquisition, an unclaimed preparation is
resolved as `never_submitted`. Claimed operations without an outcome and ambiguous legacy records
remain blocked. Invoice preparation keeps its existing SQLite lifecycle. Before upgrading, follow the
[stopped-writer migration](operations.md#journal-v2-and-owner-intent-locking-upgrade).

### Checks before each send

Every money submission (invoice, dashboard, CLI, autopilot) goes through one dispatch: under the
money lock, with no earlier operation of unknown outcome, written ahead to the log before it is sent.
Policy enforcement is delegated to the Agent API and OutLayer, with the evidence and limitations
listed in the [enforcement assessment](enforcement.md). Provider refusals are recorded.
Dispatch also refuses locally, recording why, what the provider can't see or check
(`src/authorize.ts`): a policy that is frozen, unapplied or unsynchronized; no live grant; a grant for
another purpose (the autopilot's must carry its strategy's digest); a swap into an asset the policy
doesn't list (the provider checks only the asset spent); a payout that isn't a confidential USDC
transfer, repeats one already held, or that the wallet can't cover (the provider would hold it for a
vote and fail it after); an invoice under a policy that doesn't hold it for the owner;
and a plan's send once its plan, strategy or policy changed, its valuation is unavailable, or its swap
costs more than the strategy allows. Autopilot also refuses a swap that would exceed the plan's
cumulative ceiling at observed submission-time values. Prior submitted swaps come from the existing
journal under the money lock; shields do not count and missing values do not become zero. These
checks add no persisted counter or new state format. Status reconciliation uses no grant and can
discover settlement after revocation.

A held, never-submitted invoice retains its key, can be revalidated by submitting
the original form, and never blocks other money actions; an attempted submission whose outcome is
unknown still does. Changed invoice content requires review.

Owner approval is verified from the provider's own evidence, so any instance of the agent can
approve, including an approve-only one (`EXECUTOR=off`) that never saw the payment sent. The
approval and the held execution must name each other and this agent's wallet; the approval must be
a confidential transfer whose `{to, token, amount}` hash to the provider's `request_hash` (the wallet
provider's canonical operation), to a payee, asset and amount within the applied policy (destinations,
assets, per-transaction cap, owner approval on). If this instance recorded the payment, it must match
that record and any invoice behind it must be unrevised. Incomplete or unsupported provider terms are
refused, never trusted. Preparation binds the approval ID, request hash, correlation ID, policy digest
and invoice revision; the checks run again immediately before submitting a wallet or DAO signature, and
a changed term or policy invalidates the approval. Approving needs the owner's signature, not this
instance's grant. Rejection needs only the identity checks. An attempted approval signature is
poll-only after restart or an ambiguous response, never automatically resubmitted.

These checks trust the Agent API's identity, policy and balance responses; their local observation
age is not an independent proof of chain-state freshness. A policy or revocation can change after the
final read, so the provider's own enforcement stays the boundary. The local authorization path does
not reject a policy merely because it has a provider timelock, and it does not inspect the provider's
scheduled-execution queue. Provider release-time checks remain unverified; no local hold on all
delayed execution is claimed.

### Invoice storage

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an agreement request, stored apart
from payments (`.agreements/`, `src/agreements.ts`) and never sent. Sign-in uses near-connect's wallet list pinned to one reviewed
commit (`WALLET_MANIFEST` in `src/invoice-page.ts`). Residual supply-chain risk: each wallet's code
still loads from the URL that list names, mostly `raw.githubusercontent.com`, which its maintainers
can change; the page also allows inline and `https:` scripts because wallets run as inline code in
sandboxed frames that inherit its policy. Wallets can't read the session, and every signature is
verified server-side, so the remaining risk is a wallet that phishes for keys. The provider payout policy must still require owner
approval and confidential transfers. Invoice and dashboard commands share the same execution path.

Before a payment can be sent, `.invoices/<agent>.sqlite` atomically stores the submission identity,
initial revision, exact payment request, stable idempotency key and reservation. A second transaction
marks submission attempted before network I/O. A crash after that point is ambiguous even when the
network call may never have started. Missing correlation IDs, failed reads and uncertain outcomes
never authorize another send. Reconciliation polls known operation IDs and never resends: **ambiguous
replay is not possible**.

Retries of the same form retain the same payment identity. Changed amount/note contents are retained
as revisions requiring review; they never modify an existing payment or create a second attempt.
The browser retains its pending form ID across reloads. A genuinely new form is a new business
occurrence; there is no semantic duplicate-invoice detector. Payments shows invoice revisions, operation IDs
and reserved amounts. Accounts with execution or settings permission may cancel a payment only when its durable state proves submission
never began. A held/unknown payment retains its reservation until a proven terminal outcome. These
reservations are records of encumbrances, not yet a full available-cash or liquidity-control engine.

Before upgrading an existing payout executor, follow the
[invoice migration instructions](operations.md#invoice-migration-and-deployment).

SQLite provides local atomicity, not exactly-once remote payment execution. These paths are covered
by offline concurrency, HTTP authorization and process-crash tests, and the flow ran on mainnet on
2026-10-12 ([mainnet log](mainnet-log.md)).

## Dashboard access (offline-tested)

The gateway verifies the connected account and the requested agent's owner. Wallet-owned agents admit
only that owner. DAO-owned agents admit accounts explicitly named in a Group role; `Everyone` and
token-weighted Member roles do not establish private workspace membership. After admission, applicable
Group and Everyone permissions combine, independent of role names. Exact kind/action permissions and
Sputnik's four wildcard forms are interpreted per
[contract source at 5434a59](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/policy.rs).
This is a source comparison, not verification of the deployed DAO contract version.

`src/gateway/roles.ts` derives five per-agent capabilities. The gateway and frontend use the same pure
`mayCall` table in `src/gateway/allowlist.ts`; an unknown procedure is refused even to a wallet owner.
No configured account or role name can override ownership or membership.

| Capability | Wallet owner | DAO group member |
| --- | --- | --- |
| Sign owner intent | Yes | No; the DAO supplies its signature after approval |
| Propose FunctionCall | Not applicable | `call:AddProposal` |
| Vote to approve FunctionCall | Not applicable | `call:VoteApprove` |
| Trigger execution | Yes | Both FunctionCall proposal and approval permissions |
| Change local settings | Yes | Both `policy:AddProposal` and `policy:VoteApprove` |

Execution and settings capabilities are conservative application mappings from those permissions,
not contract actions or evidence that a voting threshold was met. Proposal-only and vote-only members
cannot trigger direct execution. Existing policy, grant, reviewed-plan, executor and dispatch checks
still apply to every money action. Owner policy/grant changes and held-payout decisions still require
verified owner signatures; a member's vote alone cannot satisfy that requirement.

Members may read private records. Preparing an owner action, agreement terms, funding transaction or
plan requires the wallet owner or FunctionCall proposal permission. Saving a strategy requires settings
permission; it stops the schedule and does not authorize the new strategy. Enabling a saved, authorized
strategy requires execution permission. Stopping scheduling and reconciling existing operations allow
either execution or settings permission. The legacy combined schedule route requires both. Wallet
signature submission is available only to the owner wallet; DAO signatures follow the existing server
observation path. `ownerIdentity` is an internal gateway read, unavailable through browser RPC.

Permissions remain per agent. Shared pages have no combined workspace authority. Permission loss
disables action controls; a strategy confirmation stays invalid until reviewed again. Session and
agent-access denials hide private data. The existing intervention
classification and JSONL format remain readable; changing permissions creates no state migration.

## Frontend responsibilities (offline-tested)

Proto's frontend is the infrastructure showcase: the public entry, sign-in, the agent launcher, agent setup,
agent-access consent, walkthroughs, the Payables rehearsal and evidence. Each agent's operational screens (balances,
policy and grants, agreements, payments, strategy, runs and Activity) are in its app, Payables or Treasury, which
carry the browser suites for them (for example `test/browser/workspace.cjs`, `payments.cjs`, `policy-clarity.cjs`,
`strategy.cjs`, `run-history.cjs` and `recovery-clarity.cjs` in each app's repository).

`main.tsx` lazy-loads the authenticated application after gateway admission. The public entry is sign-in only. The
signed-in home is the launcher (`features/demo/launcher.tsx`), or `walkthrough-home.tsx` when the host offers
self-service setup; both list each agent with a link to its app, its Proto walkthroughs and, for Treasury, agent
access. The app's origin comes from the gateway's `apps` map, so a local stack links to its own hosts; the hosted
URL is used only when no host is configured (`features/demo/app-origin.ts`).

Under `/a/<agent>/`, `agent-frame.tsx` reads setup and overview. Until an agent is configured it shows onboarding;
afterwards `setup-progress.tsx` shows the next setup task, linking to the policy, grant or strategy screen in the
agent's app. Onboarding reads recorded owner actions before offering agent creation: an unfinished creation, a
succeeded creation awaiting setup readback, or unavailable records keeps that button disabled, and its refresh reads
setup and owner records without signing or submitting. A failed overview refresh keeps the retained observations on
screen; each page reports the failure itself. `test/browser/setup.cjs` and `test/browser/first-owner.cjs` check these
paths offline.

Pages that moved to an agent's app keep their Proto paths as redirects (`MOVED` in `app/router.tsx`): the same path,
query and hash in the app, with the area read from the gateway session rather than the agent's reads, so a failing
setup read never strands a saved link. `test/browser/app-redirects.cjs` reads the map from the router and checks every
path for both areas, a configured local host and a failing setup read.

The agent page (`features/demo/agent-home.tsx`) links to the app and the walkthroughs and shows the area's
requirements and evidence (`features/evidence/showcase.tsx`). Walkthrough chapters link to the agent's screens in its
app instead of embedding them (`test/browser/signing-walkthrough.cjs`). `features/demo/live-demo.tsx` is embedded only
in the Payables walkthrough: it reads the agent's observations and reuses manual payment review, the configured invoice
link and payment discovery. Prerequisite observations do not authorize actions; failed observations keep its
submission control unavailable. Explicit confirmation and required owner approval remain; no mutation runs on entry or
reload. A non-refused payment response selects its returned identity; the guide never substitutes the newest record,
and reload clears the selection. Payment records, policy, funding and recovery open in Payables.
`test/browser/live-demo.cjs` checks these paths with intercepted requests; no deployed or mainnet behavior is inferred.

`web/src/features/payables/payment-records.ts` joins retained local transfers, provider history, held observations and
owner records for display. A failed or incomplete provider history read cannot hide a transfer already present in
local activity. Display memory is scoped to the agent and document; it is neither durable evidence nor authorization.
Queue rows do not start individual status polls; the selected payment does. Approval state and settlement are read
separately. Owner action preparation exposes its correlation ID; status observation in `owner-observation.ts` stops on
unmount, and server recovery remains independent. Unit tests (`test/frontend-boundaries.test.ts`, including payment
stages) cover the derivations offline.

The invoice listener serves the page and its browser module from the same origin. The browser module owns drafts,
refresh ordering and DOM updates; TypeScript checks its JSDoc types during `pnpm typecheck`. Sign-out and an explicit
session-access denial clear private rows, invalidate outstanding status reads, stop polling and restore keyboard focus
to sign-in. Account changes clear rendered records and polling, and pending reads or submissions from the previous
session cannot update the new account's form or lists; saved drafts remain scoped by account. This does not cancel a
submission already accepted by the server. The synthetic payee journey checks request, agreement, invoice and outcome
presentation at mobile and desktop widths; owner decisions there are fixture transitions, not real signatures
(`test/browser/invoices.cjs`, offline).

### Stable area identity

An optional `area` in gateway configuration (`payables` or `treasury`) supplies `DASHBOARD_AREA` to that child process
and appears in gateway metadata. It controls presentation and which app an agent links to; policy, grant and role
checks still govern actions. Standalone or externally started agent servers can set `DASHBOARD_AREA` explicitly.
Legacy instances without it keep policy-based area inference. This is offline-tested in `test/area-config.test.ts`.

### Reads with local effects

Some existing read handlers also maintain local recovery state: `setup` may adopt a staged grant,
`held` records a provider observation when a payout leaves approval, including unresolved processing
or queued statuses that block new sends; invoice status refreshes may update the invoice
record and reservation. The executor also reconciles independently of the dashboard. These effects
are intentionally retained; consolidating presentation queries does not remove their recovery role.
A future separation must preserve restart and approve-only behavior, not merely rename endpoints.

### Agreement responses and deposit evidence (offline-tested)

The remote agreement store validates successful responses: agreement lists and terms, a nonempty
offer ID, and an explicit acknowledgment for proposing or declining. Malformed responses leave the
result unconfirmed; the client does not retry a mutation that may already have been applied.
Valid server error messages and the existing request timeout are retained. The regression fixtures
are in `test/agreement-responses.test.ts`; the local agreement record format is unchanged.

Ledger deposit lookups validate receipt structure and transfer events before selecting an asset.
Malformed evidence makes the ledger read unavailable with a sanitized error, including when a valid
transfer precedes a malformed event. Valid receipts with no matching transfer retain a null asset.
Each ledger invocation fetches each distinct deposit transaction hash once, with at most four
concurrent single-hash requests, then resolves each deposit address independently. Failed reads stop
new lookups and abort in-flight requests before rejecting. There is no persistent cache, and each
new read still looks up historical deposits. `test/ledger.test.ts` covers these behaviors offline;
this is not a deployed-provider observation or a measured production performance improvement.

### Hosted walkthrough setup (offline-tested)

`gateway/hosted-agents.ts` reserves one agent instance per owner and area under `.hosted/`, and for an app's setup per
app deployment and Organization as well.
The gateway admits verified wallets without agent access only when `selfService` is enabled.
`POST /gw/agents` verifies the requested owner type, wallet ownership or DAO group membership and
proposal permission before reserving anything. An atomic, locked registry precedes child startup;
retries reuse it. Corrupt, missing or conflicting state refuses instead of replacing settings.
The registry caps new reservations at 32 and allocates loopback ports 9000–9999. This is bounded
single-host provisioning, not a horizontally scalable or abuse-resistant hosting service.

Children receive unique settings files and immutable owner/area bindings, without inherited owner
private keys, grants, agent IDs, notification destinations or invoice listeners. `hosted-binding.ts` checks creation and DAO
relinking before provider intent generation. Existing open creation intents block a second hosted
creation. The existing owner-intent lifecycle, lease activation, authorization and single send site
remain responsible for signatures and money actions. No rule was added to `authorize.ts`.

`walkthrough-home.tsx` lists existing agents or reserves setup, waits for gateway ownership
access, then opens the agent page, where onboarding continues. Funding, grants, strategy and
agreements are in the agent's app. New Payables agents expose no inherited
invoice-service link. Configuration defaults preserve existing hosts; `deploy/dashboard.json`
selects both options for the prepared proto deployment. Nothing here establishes a mainnet observation.

## Shared MultiAgency services

The 2026-10-16 UTC [release record](proto-release-execution.md) identifies the deployed
runtime and bounded hosted observations. New-owner and scoped payee lifecycles remain
offline-tested; deployment alone does not establish those flows on mainnet.

The gateway is shared infrastructure for Treasury and both Payables workflows. `config.ts` assigns
static agents and allowed hosted areas to each domain; `demo-hosts.ts` selects actual authority,
binds sessions and rejects cross-origin access. `HostedAgents` reserves one owner/area instance,
starts it once, and reuses it across hosts. Existing wallet ownership and DAO permissions remain
mandatory on each private procedure.

`hosted-supplier.ts` derives each registered Payables instance’s payee URL and session settings.
The payee gateway proxies `/i/<instance>/` to `/supplier/` on that instance’s loopback server.
`server.ts` activates the existing executor lease before loading invoice HTTP, refusing unconfigured
instances. This is the same process and dispatch path as owner-triggered payouts. The default
payee root still proxies once to the original invoice service when explicitly configured.
Neither route retries or follows redirects. Keys, draft namespaces and records remain isolated.

New-instance templates do not carry the agency’s agents, grants or intake upstream. The populated
rollout configuration deliberately retains those original instances. No standalone volume or grant
is imported; integration and rollout boundaries are in [shared-backend-scope.md](shared-backend-scope.md)
and [shared-demos-rollout.md](shared-demos-rollout.md).

### Gateway lifecycle ownership

Proto uses pinned Effect 4.0.5 internally for child supervision. A gateway scope owns scoped
child lifetimes and restart sleeps; scope closure cancels restarts and runs bounded child cleanup
in parallel. The public start/stop facade, HTTP/oRPC contracts and independently built consumer
frontends retain their interfaces. Signaling failures or forced termination are unclean shutdowns.
See the [adoption decision and offline fault evidence](effect-supervisor-trial.md). This local
candidate is not a deployment observation. Effect does not replace the journal or executor lease.


### FastNear read lifetime and failures

`src/infrastructure/fastnear-http.ts` owns the FastNear HTTP service and its Effect layers.
Each Promise-boundary workflow builds its live layer once, capturing the transport and API key
for that workflow. Later workflows read configuration again; pages within a workflow share the
same dependencies. Tests supply a replacement layer without configuring live credentials. The
layer owns no socket pool or persistent runtime; request cancellation still owns each fetch.
This internal composition changes no consumer API, journal, executor lease or retained state.

`src/fastnear.ts` contains Proto's Effect-based indexed read infrastructure, including an injectable
HTTP service and typed, sanitized failures. Existing Promise helpers remain re-exported from
`src/chain.ts`. Each request has a 30-second deadline covering fetch and JSON body consumption.
A complete indexed-transfer scan, DAO signature search (account pages plus receipt reads), or
ledger deposit lookup group has a shared two-minute deadline. The read helpers retain Promise
returns; optional AbortSignal arguments allow cancellation without changing existing callers. Pagination refuses repeated cursors
and more than 100 pages. Malformed account and transfer pages are unavailable evidence, never
successful empty history. This does not impose a deadline on the separate Agent API reads used
by the ledger and books; those remain outside this migration.

Cancellation propagates to fetch signals; concurrent deposit reads use Effect's four-worker bound.
Failure interrupts active sibling reads and prevents queued work from starting. A pre-aborted
caller performs no FastNear fetch. There are no automatic retries, including for throttling.
Injected clients must honor AbortSignal; interruption cannot forcibly terminate an arbitrary
Promise implementation that ignores it. Receipt identity, transfer validation and cryptographic
signature verification retain their existing rules. Deposit reads remain single-hash requests.

`test/fastnear-effects.test.ts` verifies typed failures, injection, cancellation, body-consumption
and whole-pagination deadlines with TestClock. `test/fastnear-http.test.ts` verifies real HTTP
cancellation. Ledger and DAO-signature tests cover the consuming paths. This is offline evidence;
no deployed-provider behavior or new custody guarantee is inferred.
