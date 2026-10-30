# Agentic Treasury

An AI agent moves an owner's funds on NEAR Intents, only inside a policy the owner signed. This glossary
names the concepts that the code, tests and reviews share.

## Parties

**Owner**:
The wallet or Sputnik DAO that signs the agent's policy, issues its grants and approves held payouts.
_Avoid_: admin, user

**Agent**:
One Agent API agent with its own wallet, policy and grant, run by one instance of this server.
_Avoid_: bot, worker

**Treasury agent**:
An agent that swaps and shields toward a strategy without a vote per action. It runs the **Treasury**
area (docs/treasury.md).

**Payout agent**:
An agent that only makes confidential USDC transfers to agreed payees, each held for the owner's approval.
It runs the **Payables** area (docs/facilitator.md).

**Area** / **Brief**:
An area is what one agent shows: **Payables** (the payout agent) or **Treasury** (the treasury agent). A
brief is an experiment from the Agent Connect catalog that an area runs or plans, keeping its catalog
number and title (01 Confidential Treasury Facilitator, 02 Agentic Treasury Management). Each brief's
requirements distinguish mainnet observations, offline tests, pinned provider source with deployed
behavior unverified, and requirements not yet demonstrated.
_Avoid_: prototype (for an area), use case

**Workspace**:
The hosted owner entry starts with **Your agents**, agent-scoped task and recovery links, and optional
self-service setup. Opening an agent resumes incomplete setup or opens its task workspace. Guided walkthroughs remain optional.
It links funding, policy, grants, agreements and recovery for the selected agent.
The broader task workspace below remains available on hosts without walkthrough mode.
The signed-in owner's interface, with a shared Home, Payables and Portfolio sections, and Activity.
Each area retains its own agent, policy, grant, balance and access permissions. The shared Home
routes attention to the relevant area; it does not combine balances or authorize money actions.
Payables opens on Payments, with Agreements as its other task; Portfolio opens on Overview, with Strategy
as its other task. These tasks appear in the content area's navigation.
Payment queue rows include local invoices and link to one selected record; an invoice joins a payment
only through its recorded provider correlation ID. Approval and payment completion remain separate.
Payments defaults to **Needs review**: held payouts, changed or prepared invoices, owner-action recovery,
and unknown or conflicting retained outcomes. **All records** includes recorded terminal outcomes;
local recipient/reference search never fetches per-payment status or authorizes an action. Read failures
and incomplete coverage remain visible with either filter.
The desktop navigation rail and mobile drawer share the four workspace destinations. Payments includes manual payment
creation and invoice review; Agreements groups terms and separate policy inclusion by recipient.
Shared Activity retains each agent's returned operation, owner-action and run history, with links to
scoped **Operation status** controls and individual run details. Shared history supports local search and
expandable record type, recorded status and date filters. Unresolved operations, failed reads and
incomplete run records remain above the filters across all areas. Dates use local time; undated records,
including owner actions, remain included. A run ending, owner action or proposal vote does not establish
payment settlement. Operation status retains scoped URLs and links back to shared Activity.
Funding and policy are content-area utilities;
Guided walkthrough is under Help. Home keeps its real-funds entry under Guided walkthrough. Sweep is in
Balances & funding. Entry pages retain known limitations and expandable requirement evidence.
_Avoid_: entering a prototype or switching dashboards for navigation within the workspace.

**Executor**:
The one instance that sends, reconciles and serves invoices for an agent. Any other instance of the same
agent is **approve-only**: it reads and approves as the owner, and never sends.
_Avoid_: primary, leader

**Member**:
An account named in one of the owner DAO's group roles. Members may read the agent's private records;
public `Everyone` permissions and token-weighted roles do not establish private workspace membership.
For wallet-owned agents, only the owner account has access.

**Dashboard permissions**:
Per-agent capabilities derived from wallet ownership or the DAO's onchain policy, with no configured
operator list. For admitted DAO members, applicable Group and Everyone permissions combine. FunctionCall
proposal permission allows preparing requests; both FunctionCall proposal and approval permissions allow
execution controls under the existing signed policy and grant. Both policy proposal and approval permissions
allow local settings changes. These are application mappings, not proof of a passed DAO proposal.
Owner actions still require the owner's verified signature, obtained through the DAO's voting threshold
when it owns the agent. Historical records retain `operator` as the label for a manually triggered run.

**Portfolio**:
The product-facing label for the Treasury area across the walkthroughs and
signed-in workspace.
It covers allocations, rebalancing and strategy limits; the underlying treasury agent, purpose,
grant labels and routes retain their existing names.

## Mandate

**Policy**:
The owner-signed rules that the provider enforces: allowed actions, assets, caps, budget and destinations.
A policy is **in force** when it is applied, synchronized, not frozen, and bound to the agent's wallet.
_Avoid_: rules, config

**Mandate digest**:
The sha256 of a policy's canonical JSON, recorded with every plan and every money action.

**Grant**:
The owner's permission for this server to act for the agent, named by its **grant label**.
_Avoid_: token, credential (the grant token is only the secret that proves the grant)

**Grant label**:
What a grant is for, signed by the owner: `treasury`, `payout` or `invoices`, optionally followed by a
suffix such as a strategy digest (`treasury:<digest>`). Each purpose names the labels that may act for it.

**Purpose**:
Why a send or approval happens: `treasury`, `autopilot`, `payout`, `invoice` or `approval`. A purpose
decides which rules apply and which grant labels may act for it.
_Avoid_: kind, type

**Authorization**:
The single decision of whether a send or approval, with a given purpose, may go ahead, covering what
the provider can't check itself. It decides; it never fetches, sends or records.
_Avoid_: guard, gate, check

**Agreed payee**:
A recipient listed as a confidential transfer destination in a policy whose destinations mode is
`only`. A policy in `except` mode has no agreed payees.
_Avoid_: allowlisted address, destination

**Agreement**:
An owner's consent to pay a payee, with **terms**: an amount ceiling per invoice and a deadline. A payee
*requests* one from the invoice page (an **agreement request**), or the owner *offers* one first (a
service agreement, a bounty or grant award). Agreeing makes the payee an agreed payee by policy update;
the terms are this server's record, shown beside each held payout, and enforced by the vote on it.
_Avoid_: whitelist entry, PO (unless it is one)

**Work order**:
Agreed work for one payee, a fixed USDC amount and a deadline, with a dedicated agent and expiring
invoice grant. The owner signs that agent's policy and grant and separately approves its held payout.
The payee files against the order's immutable invoice identity on the invoice page. Exact terms and
one retained payment identity are application checks; the provider enforces its signed policy and
grant expiry. Expiry stops new submissions, not already accepted work, and does not return residual
funds. Work orders appear in Payables' Agreements and Payments; catalog brief 03 retains its original
title, Invoicing & Purchase-Order Management, in the audit. The implementation is offline-tested,
not observed on mainnet. Supplier conversion and forwarding are separate, unimplemented work.

**Strategy**:
The owner's target allocation and limits for a treasury agent. The autopilot acts only while its live
grant's label carries the digest of the strategy in force.

**Plan**:
A saved, expiring list of swaps and shields, bound to the policy and strategy it was made under.

**Rebalance**:
Planning swaps toward the strategy's target allocation: legs under its minimum are left alone, legs that
could cost more than its cap at their floor are left out, and the rest are saved as a plan. Nothing moves
until the plan is executed.

**Steward**:
An experimental LLM that proposes a plan in conversation, its responses verified against its TEE. It only
proposes; the plan executes like any other.

## Money actions

**Operation**:
One money action in the agent's log, identified by its idempotency key from the write-ahead record
through its outcome. New non-invoice operations record preparation and then a durable submission
claim before the provider call. A preparation without a claim proves it was never submitted; a claim
without an outcome remains unresolved. Legacy records without this distinction remain unresolved.
_Avoid_: transaction, job

**Unresolved operation**:
An operation without a proven outcome that blocks new sends: any but a held payout or a prepared
invoice, which are open but can't be lost. While one exists, no new operation may be sent.
_Avoid_: pending, stuck

**Payout request**:
A payout an app (with `payout` consent) or an owner asks for under its own `requestId`, stored by the caller before it
asks. The operation's identity is derived from the caller (the gateway's actor) and the `requestId`; the journal records
it once, so it is sent at most once, through `dispatch`, and only under a payout grant (judged as a payout; otherwise
refused before sending). The same identity is the provider's idempotency key, but at-most-once rests on the journal, not
on the provider. Asked again, or read with `payouts/status` on the agent's executor, it answers what the journal proves
(`succeeded`, `failed`, `held`, `processing`, `refused`, `unknown`, `not_found`) and sends nothing; other terms under
the same `requestId` are refused. `processing` and `unknown` block the agent's sends and are never resent. `failed`
(FAILED or REFUNDED) doesn't prove nothing moved, so a person checks before a new attempt; a new attempt is a new
`requestId`, after `refused` or that check. An approve-only copy answers no request. A named recipient that doesn't exist
on NEAR is refused `recipient_not_found` before anything is recorded (every transfer, not only requests), and
`recipient_unchecked` when the chain didn't answer; neither consumes the `requestId`. A request names `asset` and `delivery`: `intents`, a
confidential USDC transfer to an agreed payee, or `{ chain: "near" }`, a withdrawal of wNEAR (arriving as native NEAR,
per the provider's docs) or USDC, an asset the policy allows, from the confidential balance to a NEAR account the policy
agrees to pay by withdrawal; a USDC withdrawal's recipient must be registered on the USDC contract, else it is refused
`recipient_not_registered` before anything is recorded (wNEAR arrives as native NEAR and needs none). A withdrawal is public on chain and may arrive less a route fee; a held one can be rejected,
not approved, until its approval is verified.
Offline- and stack-tested, not deployed or mainnet-observed.
_Avoid_: retry (for a new attempt)

**Held payout**:
A payout the provider holds for the owner's approval. Its outcome is open, but it can't be lost, so it
does not block new sends.
_Avoid_: pending approval (as a noun)

**Refusal**:
A proven outcome that nothing was sent, recorded with a code.

**Sweep**:
Shielding the managed USDC, wNEAR and ETH public balances into their confidential balances. Other assets are not included.

**Money lock**:
The lock every money action runs under: one money-moving run at a time across this host's processes,
refused while an unresolved operation exists. It is single-host, not distributed fencing.

**Owner intent**:
An owner action (create, grant, freeze, policy update, approval vote) prepared by the server and signed
by the owner's wallet or a DAO vote, kept `prepared → submitted → settled` so a restart follows it.

**Invoice**:
A payee's request to be paid, which becomes one payout operation with a stable key and immutable terms. Until it is
submitted it is **prepared**: nothing is in flight, so it is not an unresolved operation.

## Autopilot and records

**Autopilot**:
The treasury agent acting on its own schedule, off by default: each **tick** reads the status of open
operations, sweeps, and executes a rebalance whose preview fits the strategy's auto-execute limit.
Each planned swap also requires fresh valuation and must keep the plan's gross submitted swap value
within that limit; shields are excluded from the sum. These are local checks using observed prices,
as described in `docs/enforcement.md`. A tick whose
start can't be recorded does not run; a missing end means it was interrupted or its outcome is unknown.
_Avoid_: bot, cron job

**Tick**:
One autopilot run: sweep, then rebalance if the strategy's grant approves it and the plan fits the
limit. Scheduled on the strategy's interval, counted from the latest recorded `run` summary in the
inbox, or started manually by an account with execution permission. That summary is written before the final after-observation and evidence
end; it is not proof that the tick or its operations settled. Each records a start and an end in the evidence. New ticks also record intermediate stage
starts/returns and provider-accepted submissions in a supplementary progress file. These observations
never authorize a send or establish settlement; older ticks have no reconstructed stages.

**Run log / Recording**:
A private, versioned projection of a tick's recorded observations into AG-UI events. It preserves the
tick's outcome separately from later journal observations. Missing timing stays unknown; a recorded
tick end does not prove every operation settled. It never authorizes a money action. The adapter is
offline-tested. Members can export a recording from its executor and inspect its recorded observations
in the dashboard. New exports use envelope version 3 and declare AG-UI protocol 1.0. A recorded end
with an unclosed stage or an explicitly failed run emits `RUN_ERROR`; a missing end stays open.
Older version 1/2 recordings remain readable without rewriting their events. The inspector is read-only,
with no timed playback or live stream; it keeps source
gaps, unknown timing and later observations explicit. The inspector and export access controls are
tested offline, not mainnet-observed.

**Sign-in entry**:
The public page introduces the real-funds walkthroughs and offers wallet sign-in. It shows no agent
records or requirement cards. Legacy example hashes use the same entry. The authenticated app
mounts only after gateway admission; verified self-service users may have no agent access yet.

**Hosted setup reservation**:
A durable, private instance assignment for one owner and area, created after verifying wallet
ownership or DAO membership with proposal permission. It submits no provider intent and authorizes
no money action. The owner must separately create the agent with its signed policy and issue a grant.
Retries reuse the assignment; each instance has its own settings, grant and records. Coordination
and executor leases are single-host, not distributed fencing.

**Guided walkthrough**:
A guided walkthrough in the signed-in workspace that uses the agent's actual balances, policy and
grant. It reuses the existing payment and rebalance controls, including their explicit confirmations
and owner approvals. Its prerequisite observations do not authorize a send. Outcomes come from
operation and payment records selected by the exact confirmed plan or returned payment identity;
a walkthrough can finish without a swap, wait for approval, be refused, or leave an unresolved
operation. Opening or reloading it submits nothing. Reload clears the local selection, and existing
records remain accessible through Payments and Activity.

**Inbox**:
What the agent tells its owner while no one is watching: a record of each tick, and warnings or
requests that stay open until the owner dismisses them.

**Books**:
The agent's balances checked against outside records: public balances against chain transfers,
confidential balances against the API's recorded executions. A difference is unexplained: it can reflect
outside credits or incomplete records.

**Intervention**:
A hosted dashboard call classified by the gateway's intervention list, recorded before it runs
(or not run). The unattended-run report counts them. The existing record format and historical
classification are retained when dashboard permissions change.

## Shared demo entry points

**Showcase**: `proto.multiagency.ai` introduces all three catalog ideas through static public copy
and links to their demos. It is not a Treasury redirect. Its root makes no gateway or agent reads.

**Agency Treasury**: The integrated product at `treasury.multiagency.ai`, combining Treasury,
confidential payables and work orders for the agency. Initial experiments use the existing agents
owned by `agentic.sputnik-dao.near`. This product scope does not merge agents, balances or authority.
Catalog idea 02 still means Agentic Treasury Management.

**Demo host**: An explicit gateway assignment of a host to an entry experience and named agents.
Each host has its own sign-in audience and session key. Host assignment bounds access; the owner’s
current membership and permissions still determine what each request may do. Payables covers
ideas 01 and 03: confidential invoice intake, agreements and owner-approved payouts, plus isolated
purchase orders, supplier invoices and payment tracking. Invoices is the supplier-facing entry
into Payables, with a standalone frontend repository and shared Proto backend. Its independent frontend
integration remains undeployed. Both wallet owners and DAO owners retain their approval flows.
The shared-host implementation was deployed on 2026-10-16 UTC; the bounded hosted
observations and unverified flows are recorded in docs/proto-release-execution.md.

**Shared MultiAgency infrastructure**: This repository’s gateway, owner setup registry, isolated
agent processes and supplier HTTP routing, used by all three prototype workflows. A regular NEAR
wallet owner signs directly. Sputnik DAO members sign in with their own accounts and need the DAO’s
applicable permissions; the DAO’s proposals and votes authorize its owner actions. The agency DAO
is an initial experiment, not an admission allowlist.

**Proto product direction**: Proto is both the shared infrastructure and the home for walkthroughs
and demos across all prototypes. It is evolving toward an integrated agentic treasury MVP. The
focused Treasury, Payables and supplier experiences use that foundation; their agents, funds and
authority remain separately scoped. This is product direction, not a claim that the MVP is complete.

**Scoped supplier entry**: `/i/<instance>/` on the supplier host routes to one registered Payables
executor. It has its own supplier session key, cookie name and browser draft namespace. Invoice and
work-order identities remain scoped to that agent. An unknown instance never falls back to the
agency’s intake. The unscoped supplier root retains the existing executor when configured; a fresh
installation instead asks for the owner’s supplier link without exposing an owner directory.

**Short guide / Complete walkthrough**: `/demos` collects the short versions; `/treasury`,
`/payables` and `/invoices` select an accessible agent for a complete walkthrough. Both lengths
reuse existing scoped action and recovery controls. A short guide’s AG-UI CUSTOM event is a
versioned UI observation, explicitly not an executor run, authority or payment settlement.
The current guide is deterministic; it does not invoke an LLM. A selected plan or payment stays
exact, and reload never infers a selection from the latest record. Work-order identities remain
with the existing per-order controls. These are local candidate behaviors, not mainnet observations.

**Interactive Payables demo**: The signed-in `/a/<agent>/demos/payables/play` experience has
Watch and Try modes with fictional records, plus **Use my agent**, which mounts the existing
live payment review controls. Watch plays a scripted example; Try branches into approval,
rejection or an unresolved outcome. Simulation progress is neither evidence nor authority and
is never passed to live controls. Reload restarts the rehearsal. An explicit question can ask
NEAR AI Cloud to compose an explanation and select validated catalog panels and suggested
actions, delivered as an AG-UI CUSTOM event. Generated UI contains no executable code,
destinations or signing payloads. The existing owner-intent flow supplies real messages to sign.
Generation and verification failures leave the scripted guide usable. The implementation and
mocked model integration are offline-tested; live inference and hosted behavior of this new demo
remain unverified. See `docs/payables-generative-guide.md`.

**Signing walkthrough chapters**: All three scoped short and complete walkthroughs embed existing
live controls beneath a four-chapter guide. Policy, agreement and strategy reviews open in place;
wallet signatures and DAO proposals use the existing owner-action flow. Chapter selection never
prepares an action or establishes completion. Opened reviews and exact payment/order selections
remain mounted through chapter changes. Work-order owner actions stay with the selected order’s
agent, never the parent’s owner-action history. The Payables player uses this same guide in live
mode. These interactions are offline-tested with mocked wallets and provider responses, not
hosted/mainnet observations. Treasury and Invoices chapter narration is authored, not AI-generated.


**Machine credential**:
A private bearer secret issued through Proto's shared owner access screen, delegating independent read,
plan preparation, saved-plan execution or sweep permissions for a bounded duration. It binds the host,
configured agent, actual provider agent ID and owner, is stored only as a hash, and can be revoked.
It is not a provider grant and has no separate spending budget. External saved-plan execution is not
limited by the scheduled autopilot's per-run ceiling. DAO machine delegation remains unavailable;
current DAO management rights may inspect or revoke existing access but cannot issue or use it.
The shared implementation is offline-tested, not deployed or mainnet-observed. See docs/agent-access.md
for the contract and state preservation.


**App deployment**:
One running instance of an app built on the platform (for example the MultiAgency dashboard's `staging`) that reaches the platform
server to server. The platform operator issues it an app service credential (`pnpm app-credential`), bound to
the deployment and the platform host, stored only as a hash, expiring and revocable. The credential identifies the
deployment, never a user, and authorizes nothing on its own.


**App consent**:
An agent owner's NEP-413 signature over a canonical consent text naming the platform host, one app deployment,
one Organization, the agent and its provider ID, and its scopes, with an expiry of at most 366 days. The platform checks the signature and
that the key is a full-access key of the configured owner, binds the consent to the agent's current provider ID, and
re-checks ownership and the signing key on every call: once the chain reports the key removed (on a call or the operator's
`check-keys` sweep), the consent is revoked for good. Scopes today: `read` (a fixed list of reads; no workflow records), `owner` (prepare, submit and follow owner actions,
which only the owner's own wallet signature completes; the app receives an intent only when it is NEP-413, and a NEP-366
one only as a confirm page link) and `payout` (payout requests, their status, held payouts and a deposit address to fund the agent). Wallet owners
only; DAO consent is not available yet. Revocable by the deployment or the operator; a revocation is a permanent tombstone. Offline-tested, not deployed or
mainnet-observed. See docs/agent-access.md.


**Confirm page**:
The platform's own page, `/confirm/<token>`, where an owner signs a NEP-366 owner action an app prepared. The platform
holds the intent and gives the app only the link; the page shows the agent's record of the action (requesting
deployment and Organization, agent, and for a policy edit each field before and after) to whoever holds the link, and
releases the bytes to sign only after the owner's key signs the link's readable text. It submits only the owner's
signature over the held bytes, once, before the intent expires. Offline- and stack-tested with a simulated wallet, not
deployed. See docs/agent-access.md.


**App setup**:
A wallet owner's NEP-413 signature over a canonical setup text (host, app deployment, Organization, owner, area;
at most an hour) asking the platform for a hosted agent. The platform reserves and starts it under the self-service
rules and stores a setup consent: `owner` scope for that agent only while it isn't created, so the app can
prepare its creation for the owner's wallet to sign. Once the agent exists, it only reads that agent's owner actions
until it expires, and an ordinary app consent is needed. A setup for an agent already created is refused; one deployment holds
at most 16 Organization agents per host.
An app's setup reserves that deployment and Organization's own agent per owner and area, reachable only by that deployment
for that Organization; self-service setups stay per owner and area. Offline-tested, not deployed or mainnet-observed.


**External plan**:
A saved plan prepared from an external agent's chosen, ordered swaps. Treasury obtains quotes and
checks policy, strategy, output floors and aggregate feasibility before saving the whole plan. The
`externalPlan` procedure requires preparation authority; executing its exact saved ID separately
requires saved-plan execution authority and uses the existing guarded dispatch path. Allocation-based
`rebalance` is not a substitute for chosen swaps. The shared integration and Treasury skill/client
are offline-tested candidates, not deployed or mainnet-observed.

**Standalone Invoices frontend**:
An independently built supplier experience for invoice submission/status, work-order requests and
contribution reports. Its source is in the local DAO workspace's `invoices/` repository; Proto retains
supplier sessions, scoped routing, compensation and invoice records, owner review authorization and
guarded execution. A compatible frontend release can change without restarting Proto after the shared
backend integration is installed. This extraction is a locally tested, undeployed candidate; the existing
hosted Invoices experience remains unchanged. See docs/invoices-extraction.md.
