# MultiAgency shared infrastructure and product scope

`proto` is shared infrastructure for all MultiAgency prototypes and the umbrella showcase.
Treasury is a product experience using it; Payables develops both payment workflows using it.
All three support regular NEAR wallet owners and Sputnik DAO owners with their own policies,
grants, permissions, agent instances and records. `agentic.sputnik-dao.near` is an initial experiment,
not the platform’s only eligible owner. The existing
`invoices` Railway service remains an executor responsibility, not a new product repository.

| Entry | Product scope | Candidate agents |
|---|---|---|
| proto.multiagency.ai | Static umbrella showcase for all three ideas | No public records; owner workspace after sign-in |
| treasury.multiagency.ai | Agency Treasury combining portfolio, confidential payments and work orders | Existing and owner-created Treasury and payout agents, separately authorized |
| payables.multiagency.ai | Ideas 01 and 03: confidential payments and isolated purchase orders | Payout parent; dedicated agent per work order |
| invoices.multiagency.ai | Supplier-facing entry into Payables: invoices and payment tracking | Existing invoice executor and isolated work-order agents |

Idea 01 means confidential payment intake with owner-approved payouts. A regular NEAR wallet owner
signs directly; a DAO owner acts through its proposal and voting process. The canonical proposal
emphasizes hiding DAO membership from requesters. Idea 03 means isolated purchase-order agents,
fixed supplier and invoice terms, expiry, and a separate supplier-settlement workflow. A general
invoice form alone does not satisfy it. Buyer work orders are implemented and offline-tested;
supplier conversion/forwarding and mainnet work-order demonstration remain outstanding.
The supplied Agent Connect experiment catalog and [scope audit](agent-connect-audit.md) define
these ideas; domain names do not define scope or establish completion. Existing evidence stages
remain in the canonical inventory. Steward remains hidden and experimental.

## Backend owner (decision, issue #1)

**This repository (`MultiAgency/sdk`, formerly `proto`) owns the gateway, executor and money path.**
`treasury` and `payables` are frontends: they depend on it only through `@multiagency/sdk` and the
gateway API, and do not carry `src/gateway` or the send path. `test/send-path.test.ts` (the one-send-site
test) lives here and nowhere else. Until the copies are removed from `treasury` and `payables`, a fix
to the money path is made here first and is not considered shipped for them.

## Source ownership

- `/agencies/proto`: integration, shared gateway, agency workspace, compatibility and release tests.
  It currently contains the integrated Treasury, payout, invoice and work-order implementations.
- `/agencies/payables`: develop ideas 01 and 03 together, including requester intake, agreements,
  purchase orders and eventual supplier settlement. No separate Invoices repository is planned.
- `/agencies/treasury`: Treasury product experience. Its standalone self-service installation is
  separate from the integrated agency product and retains its existing wallet state.

The sibling directories are independent source trees, not imported packages or synchronized builds.
This change establishes the integration routing and source responsibilities; it does not claim a
package extraction or move existing money-path files. Feature changes from either sibling need an
explicit reviewed integration into Proto with compatibility tests before its release. Avoid deploying
a sibling’s default configuration over the integrated gateway or copying grants to another executor.
A shared package extraction can follow a separately reviewed change; it is not required for this rollout.

## Runtime boundary

One host-aware gateway on dao serves the four entries. Its Treasury child executes; its payout child
remains approve-only. The Invoices root opens supplier intake directly; owner work-order management lives in Payables.
Invoice intake is forwarded once to the existing invoices service, where the
payout executor and isolated work-order children retain their state. No redirect or retry follows an
uncertain submission. Explicit confirmation and exact plan, operation and invoice identities stay in
the existing flows. A held payout is not settlement.

Standalone Treasury and Payables services retain their volumes and verified generated-host access.
The 2026-10-16 UTC release moved custom-domain routing without a state-format migration,
new grant or duplicate executor. See [release observations](proto-release-execution.md)
and [rollout and rollback](proto-release-review.md).

## Reusable owner and supplier services

The candidate enables bounded self-service on the shared hosts. Wallet ownership requires a verified
NEP-413 signature from a full-access key. A DAO member must have proposal permission to reserve setup;
execution and management retain the existing per-procedure permissions and signed owner actions.
An arbitrary contract account without a supported signing or DAO approval flow is not silently treated
as a wallet. This is owner eligibility, not a new way for a DAO contract to sign a supplier NEP-413 message.

One durable reservation per owner and area is reused across host entries and restarts. The registry
has a 32-instance capacity and single-host locks. A host’s `hostedAreas` bounds discovery, RPC and new
reservations; it never grants access to another owner’s records. Payables creates both idea 01 and
idea 03 workflows, with a dedicated agent for each work order. Newly reserved processes receive
infrastructure credentials only; no existing owner’s grant, notification destination or intake setting.

The supplier host maps `/i/<instance>/` to that instance’s existing loopback server. Before provider
agent creation, intake refuses with 503. Once configured, the same process and executor lease serve
invoice HTTP; no second listener, payout writer or duplicate executor starts. Per-instance session
keys/cookies and draft storage isolate suppliers’ activity across owners. A supplier link is routing,
not permission: every private record still requires the matching authenticated payee.

`deploy/shared-demos.json` preserves the existing agency agents and executor assignments while
allowing new owners. `deploy/multiagency.json` is a fresh-install template with no static agents or
legacy invoice upstream. It must not replace the former on the existing deployment, because that
would remove access to the retained agency instances. The deployed r2 uses
`deploy/shared-frontends.json`, which also pins the sibling frontend paths and static supplier URL.

These source changes add no record conversion: existing `.hosted` registry/settings and agent-keyed
journals remain authoritative. Sibling source trees remain independent; their built assets are
packaged with Proto, not converted into imported source packages. Hosted frontend compatibility
was checked within the limits recorded in the release execution document.

## Owner-first entry

The primary signed-in entry is **Your agents** when self-service or walkthrough mode is enabled.
The owner selects a wallet or Sputnik DAO and a task, then reserves or resumes one isolated setup.
`/a/<instance>/workspace` opens the task interface; incomplete creation is intercepted by the existing
setup boundary. Policy/grant, funding and activity links retain that instance scope. Walkthroughs
remain available at `/demo`, and existing exact-record URLs are unchanged.

The entry makes no readiness claim from the existence of a reservation. Policy application, a live
grant, funding and operation outcomes require their existing observations. Opening, reloading and
returning to an agent never creates a provider intent or submits money. The offline browser fixture
covers both owner types and both tasks, resuming setup and scoped navigation. It does not establish
a complete mainnet lifecycle for arbitrary owners. Self-hosted executor handoff and additional task
types remain future work; this candidate operates hosted executors with existing single-host leases.

## Walkthrough lengths and guidance

`/demos` contains short introductions and agent selection for all three workflows. The full entries
are `/treasury`, `/payables` and `/invoices`; the latter means purchase-order management, not supplier
conversion. Each links to its full product app. Selection opens an agent-scoped short or complete
walkthrough; it does not proxy, redirect or replay action bodies. Legacy `/demo/treasury` remains
an entry alias, and `/a/<instance>/demo` continues to use the existing walkthrough.

Both lengths share `LiveDemo` (Treasury/Payables) and `WorkOrders` (purchase orders). Short guides
add deterministic AG-UI CUSTOM observations; full Treasury/Payables guides expand prerequisite
context. Guidance emits no tool call or RUN_FINISHED event. It preserves selected plan/payment
identities but never establishes settlement. Work-order guidance does not infer a payment identity;
the existing selected order owns its outcome display. No model invocation or general live AG-UI
orchestration is implemented. Existing Treasury recording/export remains separate.

The routes and new guidance need offline and separately authorized mainnet validation. The complete
walkthrough is the comparison baseline, not a claim that every catalog requirement works on mainnet.
Supplier conversion and forwarding remain unimplemented. No money-path or state-format changes are
part of this UI iteration; rollback preserves all records and `.hosted` assignments.
