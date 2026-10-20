# Enforcement: what the signed policy guarantees today

Work orders bind one immutable invoice to a dedicated agent. The local dispatch check compares
payee, asset, exact amount, invoice identity, policy digest and grant deadline, after the final provider
reads; `test/work-order-binding.test.ts` covers changed terms, policy changes, deadline crossing,
concurrent filing and an interrupted outcome. These are offline application checks, not evidence of
provider enforcement against a bypassed executor. The signed transfer policy restricts destination
and per-payment cap; the grant carries its expiry. Neither expresses a lifetime one-payment limit,
exact invoice matching, nor completion by a deadline. Held payouts still need owner approval.
No dedicated work-order payment has been mainnet-observed; residual-fund recovery and payee
conversion/forwarding remain unimplemented.

Scheduling is not settlement evidence: the timer counts from the latest inbox `run` summary, which
precedes the final after-observation and tick end. An interrupted evidence start alone does not pause
that timer. Unresolved operations still block sends at the money lock. A dedicated durable scheduler
checkpoint is not implemented; `test/autopilot.test.ts` checks the current cadence offline, and
[operations](operations.md#scheduling-cadence-and-local-refactoring) describes its preservation needs.

Unreadable inbox history now defers scheduled ticks with a logged error; damaged agreement records
make their history unavailable. A new DAO delegate preparation refuses unreadable peer owner-intent
records instead of treating them as no pending action. These behaviors are offline-tested in
`test/record-corruption.test.ts`, `test/scheduler-corruption.test.ts` and
`test/delegate-waiting.test.ts`. Records still require verified recovery; automatic reconstruction
is not implemented.

Own and peer owner-intent readers also reject malformed lifecycle states and unsigned preparations
that retain a signature or outcome. Missing stages remain compatible only for unsigned legacy
preparations. Offline regressions reproduce the prior duplicate signature submission from retained records and verify
refusal without rewriting the evidence (`test/owner-records.test.ts`, `test/delegate-waiting.test.ts`).
The local reader also refuses a settled record without a recognized terminal outcome; a lifecycle
label alone cannot stop outcome polling. Peer records with incomplete settlement evidence remain
blocking. These checks do not independently prove the provider's terminal outcome.

Server startup and onboarding now share executor activation: acquire the single-host lease before
publishing a newly created agent identity, then start reconciliation, notifications and scheduling
once. A failed acquisition leaves creation recoverable with the original signature attempt;
approve-only instances start no money loops and retain their first agent identity. Shutdown cannot
publish an identity or start loops after waiting for a lease. This is offline-tested in `test/onboarding-executor.test.ts`,
`test/executor-lifecycle.test.ts` and `test/executor-creation.test.ts`, not observed on a deployed host.

Held-payout refresh now records released `PROCESSING` and `QUEUED` observations, which block new
sends until reconciliation establishes an outcome. A tick binds its captured ceiling, grant check
and plan to one strategy digest; replacing the strategy during provider reads stops that tick.
`test/payout-review.test.ts`, `test/lock.test.ts` and `test/autopilot.test.ts` reproduce these failures
and verify the corrections offline.

DAO delegate preparation now takes an owner-scoped lock across the pending-action scan, delegate
construction and durable preparation. It acquires the instance lock first, never locks a peer's
instance file, and rechecks ownership before persistence. A contender refuses for retry; a different
owner key can proceed independently. All participating processes must share owner-intent storage
on one host. This is not distributed fencing or coordination with external signing clients.

A peer delegate with an unresolved submission blocks new preparation even after its signing window
expires. A nonce read alone cannot clear it. Recovery on the original instance must record owner
success or a settled terminal outcome (including its proven signing-window closure). An owner
approval recorded as successful does not block merely because the released payout is still settling.
Settled records lacking outcome evidence remain blocked. Preparation never reconciles or rewrites a
peer record. This relies on the existing provider-status trust boundary and does not independently
prove RPC freshness or chain nonce consumption.

`test/dao-delegate-race.test.ts` uses real child processes, locks and persisted delegates with mocked
RPC/provider observations. It previously reproduced two prepared actions sharing an owner nonce;
it now requires one preparation and one refusal, including under lock loss, and checks recovery from
success, failure, and unknown status, separately from payout settlement. These are offline tests,
not mainnet observations. No signatures are submitted by these fixtures.

Settings writers now share a lock on the canonical file target, including symlink aliases. Contention
refuses the competing update for retry; it cannot silently overwrite a newer schedule stop or grant
update. This is covered by real child-process tests in `test/settings-concurrency.test.ts`, not a
mainnet observation or distributed fencing guarantee. Running processes do not automatically reload
settings written by another process. Upgrade and preservation requirements are in
[operations](operations.md#settings-and-record-read-hardening).

Schedule-stop contention is visible in the Portfolio, Payables and recovery controls: an offline
browser fixture returns the settings-lock retry error, verifies the schedule stays on and no success
message appears, then retries successfully. The mutation is not automatically retried. These cases
are covered in the Treasury app's `test/browser/strategy.cjs`; they are not deployed-browser observations.

What this prototype can claim about staying inside the owner's policy, the evidence for each part, the
gaps, and what a stronger claim would need. Dated runs are in the [mainnet log](mainnet-log.md). Further source pins and evidence are in the release record
(GUARANTEE.md), kept privately outside this repository.

**Claim:** "The prototype performs autonomous rebalancing with application checks and provider-enforced
limits. Output-asset enforcement is local, strict cumulative per-asset limits depend on provider
serialization that is not fully established, and USD-budget atomicity has not been independently verified."

## The envelope
The owner-signed policy configures the provider controls below. The API documents signing the complete
policy; independently verifying the binding from its plaintext to the signed payload remains open.

- **Allowed input assets.** The provider's `assets` list restricts what may be spent. This executor
  additionally requires swap outputs to be in the same list; that stricter check is local.
- **Permitted actions.** `actions`, with shield and unshield under `confidential`, and transfers only to
  `destinations`.
- **Per-asset spending caps.** Per transaction, hour, day and month. A swap spends its input.
  OutLayer's pinned tests show the hour and day counters as UTC calendar periods, not rolling windows
  (tests/velocity_accounting_e2e.sh:40–41); the monthly bucket key `monthly:%Y-%m` comes from coordinator
  code since removed, so its current form is unknown. The deployed version is not established.
- **A cross-asset USD budget.** The Agent API documents rolling 24 h, 7 d and 30 d windows, shared by every grant.

Outside the envelope:
- The strategy (allocation target, cost cap, per-run ceiling): an application rule bound to the owner's
  approval by the grant label.
- Holdings and their market value. Spending caps never bound exposure.
- The treasury agent's confidentiality. Per the provider docs (skills `references/policy.md`:51 at
  `2e68162`), `confidential: true` allows shield, unshield and the confidential form of each action; it
  doesn't require them. So a swap sent without `confidential: true` would spend the public balance, and an
  unshield is allowed: a misbehaving agent could move the treasury's funds into public view, though not out
  of the agent, whose destination list is empty. The resting position stays private because this server
  sends every swap confidential (`src/treasury.ts`, `swapRequest`) and deposits land confidential
  (`depositAddress` in `src/agent.ts`): enforced by our server, not the policy (see the sweep row in
  [treasury](treasury.md)). Payouts differ: each of the payout policy's destinations is confidential
  (`src/policy.ts`), so a public transfer to a payee matches no entry. Unverified on mainnet in both cases.

## How each claim is known

Each finding carries one evidence class: **observed** on our own deployment, chain reads or logs;
**tested upstream** by a provider end-to-end test at a pinned commit, not run by us; **source**, read in
pinned public source; **documented** by the provider; **inferred** from those; or **unknown**.

Provider source pins: outlayer@b8c58c0,
shared-tee-helpers@f75a74e, skills@2e68162, sdk-typescript@00cdb65, examples@859674f,
out-layer/api-spec@fb54744. The [source manifest](envelope/sources/2026-10-12/manifest.json) records their
URLs and SHA-256 hashes so each can be fetched again and checked.

**Upstream follow-up.** The historical manifest above is unchanged. The
[SDK at 8571d90](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/blob/8571d90afe892dcd4ab09dacb6081c4fd67b06d7/README.md)
also describes assets as tokens the agent may spend. The provider's
[recipient documentation at skills@8e03b0e](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/executions.md)
and [demo at 77cce32](https://github.com/NEAR-Intents-Agent-API/demo/blob/77cce320ee810fbd53916bdafd2f2a9153f50948/lib/agent-api/address.ts)
describe stripping `nearcom:` and lowercasing its account for Intents transfers. These are
documentation/source observations, not evidence of a deployed provider version.

Our dashboard normalizes owner-entered payees before policy matching and payment review; the RPC
normalizes transfer destinations before preparation or dispatch. Signed policies and provider
evidence are not rewritten. Equivalent recipient inputs reach the existing duplicate held-payout
check. Expired and revoked grants remain visible as history; only live grants can authorize new
actions. These changes are tested offline in `test/upstream-compat.test.ts`,
`test/intents-account.test.ts`, `test/form-validation.test.ts` and
the apps' `test/browser/upstream-compat.cjs`; they have not been verified on mainnet.

**Provider display follow-up (offline-tested).** Upstream's
[funds changes at demo@f888f7d](https://github.com/NEAR-Intents-Agent-API/demo/commit/f888f7d)
retain price timestamps and snake-case transaction/refund fields; its
[error changes at demo@7841c1e](https://github.com/NEAR-Intents-Agent-API/demo/commit/7841c1e)
allowlist budget and availability metadata. Our dashboard now preserves balances when prices are
missing, marks stale or unverified price freshness, and withholds the managed book's USD total and
allocation when a held managed asset lacks a fresh price. Unmanaged holdings remain listed separately.
Prices expire against the browser clock even if a refresh fails.
The demo preflight also refuses an unavailable or invalid managed-book USD total instead of
counting missing values as zero (`test/demo-check.test.ts`, offline fixtures).
The execution holdings calculation now also requires fresh prices and finite managed valuations before
planning (`test/planning-valuation.test.ts`). Managed-asset metadata in the dashboard falls back to this
application's fixed asset definitions if the catalogue
omits an asset; unknown unmanaged decimals remain unknown.

**Execution valuation (offline-tested).** Dispatch records the input value and authorizes a planned
swap using one observation time after its provider reads. Missing, expired or invalid input/output
valuation refuses with `valuation_unavailable`, including before a prerequisite shield. The swap is
checked again before submission. For autopilot, prior submitted swaps for the same plan are counted
once at their recorded gross values, plus the proposed swap at its current observed value. The cumulative
check sums and compares each numeric estimate's shortest decimal representation exactly. This avoids
additional rounding during accumulation; it does not recover precision lost when an estimate was
calculated. An excess refuses with `autopilot_limit_exceeded`; equality is permitted. Shields, proven refusals and
never-submitted preparations do not count. Missing historical values refuse rather than count as zero;
refunds do not replenish the ceiling. Manual plans retain their separate execution behavior.
`test/strategy-value.test.ts` and `test/planning-valuation.test.ts` cover decimal comparisons, freshness,
cumulative accounting and recovery. The plan remains single-use, and an unresolved operation still
blocks new sends. These checks enforce the existing local strategy ceiling. Policy caps and USD-budget
enforcement remain the provider's responsibility. Raw-amount conversion, individual valuations and the
earlier plan-preview total still use floating-point arithmetic. Exact accumulation does not establish
exact valuation, settlement-time prices or fees, or provider accounting. No deployed observation is claimed.

RPC errors and immediate payment refusals carry only validated budget-remaining and availability
metadata. Availability is an observation, not permission to retry; ambiguous outcomes remain unresolved.
Supplementary refusal metadata is not persisted in the journal. Payment review shows provider-reported
transaction hashes and refund fields, marks missing evidence explicitly, and does not infer an explorer
URL, refund asset, or independent settlement proof. Refund amounts remain exact raw units. These changes
are covered by `test/provider-display.test.ts`, `test/provider-values.test.ts`,
`test/payment-status.test.ts` and the apps' `test/browser/provider-display.cjs`; deployed behavior is unverified.

**Deployed identity is unknown.** `outlayer.near`'s code hash is `2K9si4Kct6awAvbUTgAohivmfnGHV3UVXJc9KyQqvsae`
with no build metadata, and its build script isn't reproducible. The coordinator reports `git_sha`
`ff99b418b1be-dirty` (built 2026-10-09), a commit not in the public repository. No build identity was found
at the Agent API's `/health`, `/version` or OpenAPI version on `api.agentsonintents.com` and
`api.demo.agentsonintents.com` (2026-10-13); the hosted services' API host wasn't inspected. On-chain TEE measurement allowlists exist with no mapping to source. So source facts
below describe the pinned code, not necessarily the running service; that is not proof they differ.

Upstream documentation disagrees with itself in places: the skills reference calls per-asset limits
"rolling" while the upstream tests use UTC calendar periods for hour and day, and OutLayer's CUSTODY.md says usage is
recorded post-settlement (:386, current) and before execution (:1077, older, matching removed code).

**Provider documentation reviewed 2026-10-15.** The
[Agent API policy reference at skills@b639531](https://github.com/NEAR-Intents-Agent-API/skills/blob/b63953155cd39d127f529f54e18275639bffbaed/near-intents-agent-api/references/policy.md)
assigns USD budgets and destinations to the API and documents atomic USD charging at dispatch.
[OutLayer's custody reference at 635d273](https://github.com/out-layer/outlayer/blob/635d2736b39acbccc885b0f57fb38a21ee091fc4/CUSTODY.md#policy-evaluation-flow-inside-tee)
describes cumulative asset and rate counters as best-effort under concurrency, dependent on
coordinator-supplied usage. These are different enforcement layers. That general custody description
does not establish a failure of the Agent API's USD budget, and the API's documented atomic charging
does not independently verify its deployed implementation. The relationship between the custody
description, pinned serialization tests and our deployed route remains a provider clarification.
We retain the existing provider controls and local checks; this review introduces no local budget engine.

## Status
| Constraint | Status |
|---|---|
| Output asset | **Documented provider limitation relative to our stricter requirement.** A direct-API mainnet swap into an asset outside `assets` succeeded (2026-10-10, [log](mainnet-log.md#a-swap-into-an-unlisted-asset-2026-10-10)). The provider now explicitly documents `assets` as tokens the agent may spend; swaps may buy unlisted tokens ([skills@8e03b0e, policy reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/policy.md)). This agrees with the input-only check in the pinned policy engine (wallet_policy.rs:467–476, :1011–1014). Our executor retains the stricter output check (`outputAssetRefusal`, src/policy.ts); provider output-asset enforcement is not claimed. |
| Cumulative per-asset caps | **Serialized per wallet, per upstream tests; strict enforcement unproven. A monthly-cap refusal is observed:** on an isolated agent, after a settled small USDC swap, the identical request was refused with `policy_denied` and nothing dispatched; only the monthly cap, set below the two swaps together, was exceeded (2026-10-13T03:27Z; [mainnet log](mainnet-log.md#isolated-test-agent-shield-and-monthly-cap-2026-10-13t0327z)). Sequential, not concurrent. Upstream end-to-end tests show that of two simultaneous spends against one limit exactly one passes, that usage is written while the wallet is held, that every caller shares one usage row, and that a crash leaves an operation uncharged until a later read repairs it and charges it once (outlayer@b8c58c0 tests/wallet_concurrent_spend_e2e.sh, velocity_two_doors_e2e.sh, stuck_request_repair_e2e.sh). The API specification documents that a swap holds the wallet for its duration. Unknown: whether new admissions are blocked until a crashed operation is repaired, how the lock coordinates across service instances, and which version is deployed. The coordinator is private. |
| USD budget | **Held in one concurrent trial; mechanism unverified.** Five simultaneous identical small swaps sent directly with one grant, with room for two: one executed, one got `wallet_busy`, three got `spend_budget_exceeded`, and the budget did not overshoot (isolated agent, 2026-10-13T03:32Z; [mainnet log](mainnet-log.md#isolated-test-agent-usd-budget-under-concurrency-2026-10-13t0332z)). Admission was more conservative than the reported remaining budget. One trial, one grant, one host: not proof of atomicity across grants or instances, or after a crash. |
| Signed policy binding | **Not independently verifiable.** The API's `policy_hash` is reproducible: sha256 of the returned policy with sorted keys (recomputed on 2026-10-13 for all 15 returned revisions: treasury 1–11, payout 1, isolated agent 1–3). The on-chain `agent_policy_hash` is not a function of the policy (two treasury revisions share one `policy_hash` but carry different `agent_policy_hash` values on chain), and the public `store_wallet_policy` takes no such argument. The enforced policy is stored encrypted to a custody keystore key and signed by the custody wallet key, not the owner, so it proves neither that the owner signed those terms nor that no owner authorization exists elsewhere. A NEP-413 `update_policy` message, captured unsigned on the demo host, carries the complete plaintext policy, revision, agent, owner and domain, so an owner can read what they sign for API-enforced edits; whether the provider-enforced part matches it is the open question. A NEP-366 `policy_update` (an asset change), also captured unsigned, signs only a delegate to `store_wallet_policy` carrying `encrypted_data`: the readable policy appears only in the unsigned preview, so for those edits the owner signs ciphertext. What the message's `target_id` identifies is unknown. Captures are in the private release record. |
| Execution artifact | **Coordinator trust assumption, in pinned source.** For swaps and confidential transfers (including payouts), the keystore checks only that the signed message is addressed to `intents.near` or `intents.far`, then signs it unparsed (keystore-worker/src/api.rs:5729–5786). Our approval check binds the intended payment locally (payee, amount, asset to the provider's request hash), and the owner's approval binds whether the operation runs; that the final signed artifact carries those terms depends on an honest coordinator. Deployed behaviour unknown. |
| Operation audit proof | **Unavailable on the sampled deployment.** At 2026-10-13T04:10Z, all three sampled successful operations returned HTTP 501 `transparency_log_disabled` from the demo API. The run is in the [mainnet log](mainnet-log.md#policy-signatures-and-operation-proofs-2026-10-13t0410z); operation ids and captures are in the private release record. Even an available event inclusion proof would not by itself establish signed spending bytes, complete history or atomic enforcement. |
| Input asset, actions, frozen, per-transaction cap | Enforced in the provider's TEE, per its source. The deployed version is not established. |
| Destinations | Enforced by the Agent API, per its docs. One mainnet refusal was observed. |
| Deposit conversion | **Scope question, not a known spending bypass.** Public API docs explicitly say deposits need an API key, no grant or owner signature, and do not spend treasury funds. Whether the agreement restricts conversion targets, and whether that is enforced, remains open. |
| Shield under a non-empty `only` list | **Observed working on an isolated agent.** Under a destination list copied byte-for-byte from the treasury's (revision 11), a shield of its public wNEAR succeeded and charged no USD budget (2026-10-13T03:27Z, an isolated test agent; [log](mainnet-log.md#isolated-test-agent-shield-and-monthly-cap-2026-10-13t0327z)). For the treasury agent’s subsequent sweep observation, see the [canonical Treasury requirements and evidence](treasury.md#02-agentic-treasury-management). That observation does not independently establish enforcement under every destination configuration. No `policy_confidential_whitelist_conflict` exists in any public source. |

## Recovery limitation

In current local source, `src/ops.ts` treats `SUCCESS`, `REFUNDED` and `FAILED` as terminal;
`src/recover.ts` records the status without checking separate non-execution evidence. Invoice
accounting also treats those statuses as terminal (`src/invoice-store.ts`). This relies on provider
status semantics. It does not independently establish that a failed operation had no payment effect
or that a replacement payment is safe. Acceptance case E7 requires that distinction; it remains open.
A missing operation ID on a claimed or legacy operation cannot be repaired by status-only reconciliation.

**Shared builder payouts (offline-tested and simulated E2E; not mainnet-observed).** A contributor report may be paid
from the payout agent's shared balance when the owner chooses `shared` at preparation; isolated order agents remain the
default path (owner decision, 2026-10-19). A shared send whose response is lost keeps its effect but leaves no operation
ID, so the payment stays `UNKNOWN` even after approval and settlement, is never sent again, and blocks the payout
agent's later sends until reviewed (`test/e2e/shared-payout.spec.mjs`). A send refused by Proto's own checks before
submission leaves the payment prepared on its identity for a later send (owner decision, 2026-10-18;
`test/compensation-http.test.ts`). **Open dependency for making shared the default:** observed provider behaviour for
looking up, or deduplicating, a submission by its idempotency key, so a lost response can be resolved without
reconstruction. That is not observable under the current boundaries.

**A lost provider reply blocks its executor until reviewed, on every send path (offline-tested; not mainnet-observed).**
This is not specific to shared payouts. Any send through `dispatch` (manual payments, invoice and order payouts, swaps)
whose provider reply is lost is recorded as submission-attempted with no operation ID. It is never sent again, and it
blocks that executor's later sends (`test/journal.test.ts`, `test/money-safety.test.ts`,
`test/invoice-durability.test.ts`). The payout itself stays
reachable: the held-payout list also reads the provider's own history (`src/payouts.ts`, `heldElsewhere`), so the owner
can still approve it by signature and it can settle.

The blocked operation does not clear, even after settlement. `recover()` polls only operations with an ID and reports this
one as "acceptance is unknown… review required" (`src/recover.ts`). The provider's history entries carry the operation ID
but not the idempotency key, so the only link to the recorded attempt would be matching terms and time, which Proto does
not do. `pnpm reconcile` does not clear it either. The refusal names such operations, says reconcile cannot resolve them
and points here (`src/lock.ts`, `test/money-safety.test.ts`).

When the provider answers a claimed send with an error that doesn't prove a refusal, the executor keeps that answer as
evidence (offline-tested, `test/submission-evidence.test.ts`): HTTP status, error codes, a shortened message with
credential-like values removed, the provider's `requestId`, and any operation or correlation id the provider included
(its error document defines none). It goes in `.ops/<agent>.submission-evidence.ndjson`, beside the journal rather than in
it, and `unresolved` and `pnpm reconcile` show it. It resolves nothing and changes no send, refusal or block. A
`requestId` identifies the failed request for diagnosis with the provider. Retaining it doesn't establish which provider
operation the request became, whether anything executed, or permission to clear the operation; the output says so. A lost reply leaves no provider answer and records no evidence.
Earlier builds never read the file, and their journal reader and `journal:check` are unaffected (checked against the
deployed bf59054e reader on 2026-10-19), so rolling back across this change keeps every journal readable.

There is no supported review procedure yet. Until the provider's idempotency-key behaviour is observed (the open
dependency above) or an evidence rule for clearing is decided, the executor stays blocked. Its records must not be edited
by hand. Reproduced offline on 2026-10-19 with the provider mocked at its API boundary, as a scratch reproduction
that is not part of the test suite: one transfer, a refused second send, the payout approvable from the provider's
history, and the operation still unresolved after settlement.

The [SDK recovery guidance at 20ca15c](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/blob/20ca15c0bd54b6f15b22773de0ad4007b16ea851/README.md#L348-L360)
explicitly allows partial effects under `FAILED`; neither `FAILED` nor `REFUNDED` proves nothing was
sent. Its [budget-release contract](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/blob/20ca15c0bd54b6f15b22773de0ad4007b16ea851/README.md#L288-L289)
names `details.never_executed` or `details.never_submitted` for releasing a failed operation's USD
charge once. These provider statements sharpen the existing gap: an operation ending and a replacement
payment being safe are different conclusions. They do not independently prove deployed accounting.

**Original invoice replay (offline-tested).** The application has no automatic replacement path for
an existing invoice: filing the same payee/submission identity returns its recorded result, revisions
retain the original payment, and submission requires the original attempt still to be `PREPARED`.
`test/invoice-terminal-replay.test.ts` uses real SQLite and separate processes to check that failed or
refunded outcomes, including responses carrying absent, non-execution, partial-effect or conflicting
details, cannot authorize a second send for that identity. The original key, correlation ID and request
remain unchanged across restart, filing, revision, reconciliation and attempted continuation.

These tests do not classify the provider's effect evidence: the journal retains status, not those
details, and terminal records stop automatic reconciliation. Releasing an invoice's SQLite reservation
is local bookkeeping; it neither restores the provider's budget nor proves funds returned. A manual
payment or invoice with a new submission identity is distinct work and still requires review of the
earlier payment. Matching recipient and amount alone cannot distinguish a replacement from another
legitimate obligation. No new money-path rule or provider guarantee follows from these tests.

## Local presentation limits

Hosted access is derived from verified wallet ownership or the owner DAO's named groups and permissions;
the former configured operator list grants no access. The gateway's execution/settings mappings are
local application controls, not evidence that a DAO proposal passed. Existing owner signatures, provider
policy and grant checks remain authoritative for money actions. See the
[exact access mapping](architecture.md#dashboard-access-offline-tested).
Token-weighted `Member` roles are not supported for private workspace admission; that would require
verified delegated voting balances. Public `Everyone` permissions contribute only after Group admission.
The gateway caches DAO policy for up to a minute, so removal may take that long to affect access.

Source-review limitation: work-order `get` and `status` reads start retained child processes through
`src/work-order-pool.ts`. The pool defaults to eight workers and currently removes them only after
process exit. An admitted reader can therefore fill that capacity by inspecting different orders;
idle-worker retirement remains open. This is an availability limit, not additional signing authority.

An explicit session or agent-access denial hides retained private records in the shared Home and agent
views and refreshes gateway permissions. This includes decoded proposals cached for a DAO shared by
multiple agents: denied-agent payloads are removed while permitted sibling proposals remain, and late
responses cannot restore denied payloads. A procedure-permission refusal leaves permitted member
reads available without repeatedly invalidating its own query. An agent procedure refusal clears that
agent's cached action permissions until a successful permission refresh; failed refreshes cannot restore
them. Delayed owner-action callbacks check current permissions before preparing. Expired invoice-page
sessions clear rendered records and invalidate outstanding reads;
account-scoped draft submission identity is retained for signing in again. Offline browser regressions
in `test/browser/invoices.cjs` and the apps' `test/browser/access-expiry.cjs` reproduce the previous cached-data
exposure and verify the correction. A transient provider failure still permits explicitly stale
observations. Policy digests identify reported policy JSON; they do not verify the owner's signature
or the provider's enforcement. These tests do not establish hosted behavior.

The public and member requirement views list individual controls and evidence stages without counting
them as guarantees enforced by the signed policy. This presentation change is browser-fixture tested,
not verified on the hosted deployment. The underlying provider dependencies above still apply.

Agreement terms are voter guidance, not an invoice-to-agreement binding. An owner offer is marked
filed when any later invoice from that payee exists (`src/agreements.ts`); multiple offers can match
the same invoice. Payment review shows the payee's latest non-declined recorded terms, which need not
be the terms of that invoice. The browser regression covers selecting the latest terms, including
excluding declined agreements and other payees. It does not establish agreement-specific enforcement.

Autopilot summaries distinguish swaps skipped for cost from a book with no rebalance legs meeting
the minimum size (`test/autopilot.test.ts`). This correction is offline-tested, not mainnet-observed.
Historical summaries are preserved; a past "book on target" message alone does not establish that
the allocation matched its target. Report classification still relies partly on historical English
summary prefixes (`src/report.ts`); replacing that with structured outcomes requires a compatible
record-format change.

## Local crash and concurrency recovery

Offline process tests cover two fixes, in source commit `a23f0e1`, which the deployer reports as the
deployment of 2026-10-13 (dao `2713d2ea`, invoices `07a35af2`); the deployed source itself isn't verified:

- Journal v2 distinguishes a durable preparation from a submission claim. The sole send site writes
  the claim before the provider call. The next money-lock holder resolves only unclaimed v2
  preparations as `never_submitted`. Claimed, legacy and malformed records never gain an inferred
  non-execution outcome. Prepared invoices retain their existing SQLite continuation rules.
- Owner-action updates acquire a per-instance lock, reload durable state, and serialize preparation,
  submission, reconciliation and expiry. Separate processes retain both preparations and cannot
  overwrite another process's settled result with an older snapshot. Simultaneous first submissions
  observe the saved lifecycle before deciding whether to send.

The tests use real processes and storage with offline provider stand-ins (`test/journal.test.ts`,
`test/owner-intents-race.test.ts`). Locks are single-host leases; they do not fence a stalled process
across hosts or prove remote exactly-once execution. See the
[upgrade procedure](operations.md#journal-v2-and-owner-intent-locking-upgrade).

## Two facts that limit any local guarantee
- **One live grant is not one sender.** Any number of processes can share a token. Counting grants fences
  nothing. Our money lock is a file lock on one host. The only cross-host serializer we know of is the
  provider's per-wallet lock (`wallet_busy`); its interval relative to usage recording is unknown.
- **A local journal gives a local guarantee.** It bounds operations this executor sends. It can match the
  provider's envelope only after these are specified:
  - initial usage reconciliation, from the provider's history, for activity before the journal existed;
  - accounting prices: which quote, and whether charges are trued up to `amount_in`;
  - windows: hourly and daily per-asset counters in UTC calendar periods (pinned tests), the monthly
    bucket unknown, USD budget rolling 24 h / 7 d / 30 d (docs), with edges confirmed on the deployed version;
  - unresolved operations: reservations kept on unknown outcomes;
  - policy changes: reductions never release usage;
  - external activity: operations other senders made, seen only once they reach the provider's history.

## Smallest implementation sequence

### Existing integration and independent verification
1. **`authorize.ts`**, the confirmed single authorization rule, plus the output-asset rule: a swap whose
   `destination_asset` is outside `assets` is refused and recorded before anything is sent.
   - Done: the pure rule (src/authorize.ts) and its purpose-by-rule tests (test/authorize.test.ts).
   - Done: wired into `dispatch` (every send), `checkPaymentApproval` and `invoices.agreed()`. Plan
     refusals are now logged with their codes. The authorization regressions are plain tests (test/authorization.test.ts).
   - Trimmed at the user's direction to what the provider can't check: the identity and
     agent-status rules (and their two reads per send) are gone, and sends leave payees and the
     per-transaction cap to the provider. Approvals still check payee and cap against the policy now,
     since the provider checked them under the policy when the payment was requested.
   - Verified in current local source. Deployed-source correspondence was not established by the public-documentation review; do not infer deployment from these tests.
2. **One grant-using send site, enforced.** Done: test/send-path.test.ts fails if anything but
   `dispatch` → `send` (src/agent.ts) calls swap, transfer, shield or unshield on a grant, or if
   the quote in src/treasury.ts `quoteLeg` stops being `dry: true`.
3. **Verify execution routes.** The credential and route inventory (M1) is
   kept locally, outside the repository (research/enforcement/M1-CREDENTIALS.md). Check which rules
   the Agent API and OutLayer enforce on every route available to the agent, including direct use of
   its grant. Application checks cover only the executor's code path.
   - The steward today only proposes plans, and execution goes through `executePlan`, so it has no
     direct send.

### Resolve with implementation and deployment evidence

Keep the Agent API and OutLayer integration. Public-source review and authorized isolated tests can
proceed independently; ask providers for evidence that cannot be obtained that way. Missing evidence
does not justify a separate signer, custody contract or local budget engine.

| Finding | Then |
|---|---|
| A future provider change adds output-asset enforcement at admission | Confirm deployed behavior with acceptance test E1 before strengthening the claim. Keep the local rule. |
| Current documented spend-only asset semantics | The output-asset limit remains an application guarantee. The 2026-10-10 observation is consistent with that limitation. |
| `wallet_busy` serializes until usage is durable, across hosts and grants | No local per-asset reservations. Confirm with E2–E4. |
| It doesn't | Record the exact failure and required provider correction. Keep strict cumulative enforcement unproven. |
| USD charging is atomic, with stated semantics | Rely on it. Confirm with E5–E9. |
| It isn't | Record the exact failure and required provider correction. Keep atomic USD enforcement unproven. |
| Deposit conversion spends treasury funds, or the agreement must restrict acquired assets | Add deposits to `authorize` as their own admission path. |

## What a stronger claim needs

The target is conditional: an agent submitting arbitrary requests cannot cause an execution outside the
owner's signed policy, assuming named enforcement and custody components stay correct. Today's evidence
does not establish it.

**Threat model.** The agent may submit anything, use every credential it has, run copies on several
hosts, retry after timeouts and bypass the planner and this server's checks. Requests may be delayed,
reordered, duplicated or lost; processes may crash anywhere; policy changes and revocations may race
with pending work. The owner is trusted to sign the intended policy (signing a wider one changes the
agreement; it isn't a bypass). The Agent API, the OutLayer coordinator, the custody keystore and the
valuation source are trusted unless an obligation below removes that dependency. Nothing here tolerates a
malicious custody provider, a compromised owner or an arbitrary database rollback. The agent must not hold
the owner's signing authority or be able to cause an unreviewed signature; the CLI's owner key is reviewed
separately from the hosted DAO deployment. Protection against a compromised coordinator would need the
signing boundary to verify the actual transaction terms; application checks and credential isolation
alone can't provide it.

**Seven obligations**, each to be shown established, conditional on a named component, or unresolved:

1. **Signed authority:** the enforced policy is the policy the owner signed, for this wallet and domain.
2. **Complete mediation:** every route that can debit the wallet passes enforcement: other grants and
   hosts, approval release, recovery, withdrawal, any general signing.
3. **Atomic admission:** concurrent requests can't spend the same capacity.
4. **Execution binding:** the signed artifact carries the admitted terms, and its debit fits.
5. **Durable conservation:** settlement, refunds, crashes, retries, migrations and policy changes never
   erase a possible charge.
6. **Bounded replay:** one admitted operation can't execute twice.
7. **Fresh authority:** policy changes and revocations are ordered against admission and the last
   irreversible point; held work can't keep obsolete authority.

For each capped dimension (an asset or the USD budget, per window), admission requires
`charged + outstanding + proposed ≤ limit`, in integer raw units and exact decimal USD. Accounting rules
still to pin down: the gross amount charged (fees, refunds); window edges and timestamps; the USD price,
rounding and fees; how shield and unshield count per asset; whether queued or held work reserves capacity
or is re-admitted on release; that an unknown outcome keeps its liability until non-execution is proven;
that a lowered cap keeps existing usage; and the last cancellable point for a revocation. Two facts bear
on these: queued (timelocked) work reserves nothing, per the provider's examples; and policy writes are
not serialized with spends (inferred: the owner stores policies on chain and the keystore re-reads them
on each check). This server's floating-point `usdIn` is a record, not authoritative accounting.

**Two observed held payouts were committed before approval.** Our provider readback
(2026-10-13T04:10Z) showed that both held payouts of 2026-10-12 recorded `dispatch_committed_at` 10 and
56 seconds before their approval requests (21:47:00Z then 21:47:10Z; 22:16:35Z then 22:17:31Z).
The [API recovery reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/status-and-recovery.md#L113-L117)
places the revocation/freeze cutoff at dispatch commitment. However, its
[conceptual pipeline](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/concepts.md#L73-L85)
places the approval wait before that commitment. This documentation mismatch does not establish
the deployed ordering of every check. OutLayer source (`outlayer@da5c9ff`, keystore worker) rechecks
frozen, input asset and the per-transaction cap before signing, and cumulative caps only when the
coordinator supplies usage. API commitment and keystore signing are separate boundaries. Whether a
reduced cap, changed destination, freeze or revoked grant stops an already-held payout remains
unverified on our deployed route; the timestamps alone do not prove that it will or will not.

**Open cases.** Local checks that pass: an unlisted output asset refused with no send (A1) and a policy
change between preview and execution refused (A3), both in the local regression suites; one send site (C1,
`test/send-path.test.ts`, a maintenance check: grant tokens are readable outside the executor's code
path, so it doesn't constrain anyone holding the credentials); gateway denial (G1, `test/gateway-denial.test.ts`); the member
allowlist matching every procedure (G2, `test/member-access.test.ts`). Observed on the isolated agent: the
monthly cap, sequentially, and a shield under a non-empty destination list (E10; unshield not yet run);
the USD budget under one concurrent trial (E5, once). Still open: verifying an owner signature against
the enforced policy (S1, S2); the credential and route inventory (M1); a direct-credential swap into an
unlisted asset refused upstream (E1; requires a provider capability beyond the documented spend-only
asset list, with the 2026-10-10 success preserved as historical evidence); per-asset caps under
concurrency, across grants and instances (E2–E4); retries around timeout and restart (E6); release on
proven non-execution only (E7); tightening the policy while work is queued or held (E8); revoking or
freezing at each dispatch boundary (E9); crash points (E11); window edges (E12); price and rounding edges
(E13); artifact binding (E14); rolled-back accounting (E15); operation-proof verification (P1); the
offline accounting cases of an executable model (B1–B7: two fitting admissions that jointly exceed a
cap, window boundaries, unknown outcomes keeping their reservation, same-key retries, a crash before
the claim, a policy reduction); and the output-asset refusal for steward legs (A2: plan legs and the
autopilot purpose are covered in `test/plans.test.ts` and `test/authorize.test.ts`).

Funded tests run only with the owner's authorization, on an isolated agent with tiny limits and a stated
loss ceiling, never on a production agent; stop on any unexpected admission, unidentified operation or
ambiguous outcome, and poll the same operation rather than retrying under a new key. Run each
concurrency case from one grant and from distinct grants and hosts, with enough balance and a valid
route that an unrelated refusal can't pass for a cap. A refusal needs
attribution: `spend_budget_exceeded` identifies the budget, but `policy_denied` alone doesn't identify
which cap.

### Repository review, 2026-10-15

The four public repositories answer integration questions; they do not contain the Agent API's
server-side budget accounting or custody coordinator implementation. This read-only source review
ran no examples or funded tests and does not identify a deployed provider build.

| Repository | Reviewed revision | Scope |
|---|---|---|
| [skills](https://github.com/NEAR-Intents-Agent-API/skills/tree/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1) | `8e03b0e` | API guidance and reference clients |
| [sdk-typescript](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/tree/20ca15c0bd54b6f15b22773de0ad4007b16ea851) | `20ca15c` | HTTP client, generated contract, proof verifier and client tests |
| [demo](https://github.com/NEAR-Intents-Agent-API/demo/tree/77cce320ee810fbd53916bdafd2f2a9153f50948) | `77cce32` | Dashboard and MCP integration calling the external API |
| [examples](https://github.com/NEAR-Intents-Agent-API/examples/tree/6cf51ee9e9746ba0489a06ace4547148b09854eb) | `6cf51ee` | Integration recipes, not provider enforcement tests |

1. **Shared spending limits: the contract is explicit; the implementation remains unverified.**
   The [policy reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/policy.md#L47-L64)
   documents an account-wide USD budget, atomic charging at dispatch and refusal without fresh prices.
   The SDK preserves caller-supplied idempotency keys and performs no automatic retry; its
   [tests](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/blob/20ca15c0bd54b6f15b22773de0ad4007b16ea851/tests/idempotency.test.ts#L139-L224)
   check client behavior with mocked responses. They do not establish server deduplication or
   capacity conservation across grants, instances and crashes. The recovery contract above and
   OutLayer's qualified cumulative counters remain distinct from this documented USD guarantee.
2. **Held payouts: use the existing controls, with their dispatch boundary visible.**
   The [timelock recipe](https://github.com/NEAR-Intents-Agent-API/examples/blob/6cf51ee9e9746ba0489a06ace4547148b09854eb/10-recipes/02-timelocked-payout.ts#L1-L17)
   documents no USD reservation while queued and invalidation on a policy revision change; it also
   demonstrates `execution_cancel`. Queued work and a provider-held approval are different states.
   The ordering mismatch above remains unresolved. The SDK's
   [containment response](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/blob/20ca15c0bd54b6f15b22773de0ad4007b16ea851/src/generated/api.d.ts#L2694-L2720)
   explicitly labels provider enforcement and direct-provider-key bypass `unverified`.
3. **Signed terms: approval binding exists, with a documented coordinator dependency.**
   The [demo approval flow](https://github.com/NEAR-Intents-Agent-API/demo/blob/77cce320ee810fbd53916bdafd2f2a9153f50948/features/wallet/approvals/use-approvals.ts#L62-L75)
   displays provider-generated approval terms; it does not independently verify the final artifact.
   [OutLayer's custody reference](https://github.com/out-layer/outlayer/blob/635d2736b39acbccc885b0f57fb38a21ee091fc4/CUSTODY.md#L489-L505)
   describes verification of approvals over the canonical operation, while swaps and confidential
   operations trust the coordinator to match the signed artifact's token and amount to that operation.
   The SDK's operation-proof verifier checks logged evidence and signatures, not enforcement or the
   TDX quote; [attestation remains a separate check](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/blob/20ca15c0bd54b6f15b22773de0ad4007b16ea851/README.md#L291-L309).

**Effect on the feature gaps.** [Grants identify actors and expiry, without separate permissions](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/concepts.md#L17-L32).
Recipient restrictions and spending caps belong in the shared policy. Its schema has no
agreement-specific invoice ceiling or absolute deadline; the weekly schedule and grant expiry do not
bind an invoice to an agreement. The existing owner vote therefore remains responsible for those terms.
The [private-balance example](https://github.com/NEAR-Intents-Agent-API/examples/blob/6cf51ee9e9746ba0489a06ace4547148b09854eb/05-money-moves/05-private-balance.ts#L43-L56)
unshields a supplied amount; it does not implement an atomic shortfall-and-payout operation.
These repositories do not close the documented membership-privacy or unattended-operation gaps.

**Validation follow-up.** The original-invoice replay checks above cover the existing local protection;
they do not establish whether a new payment is a safe replacement. Provider non-execution evidence and
budget-release semantics remain unverified. The separate funded check still needed is whether tightening
a per-transaction cap on an already-held payout refuses signing after approval. This review and its
offline follow-up change no money-path behavior or canonical requirement evidence stage.

Missing evidence narrows the claim; it doesn't call for a separate signer, custody contract or local
budget engine.

**Dashboard review freshness (offline-tested).** Dashboard payments carry the policy revision and
mandate digest shown at review. Dispatch compares them with its fresh policy read under the money
lock and records a refusal before submission if either changed. Policy updates likewise require the
reviewed revision and digest before generating the owner's signing payload; the generated request
retains the provider's `expected_revision`. An open editor preserves its draft after a refresh and
requires an explicit comparison against the new policy before re-review. Tests are in
`test/policy-review.test.ts` and the apps' `test/browser/web-interface.cjs`; this is not mainnet-observed.

The payment check is local: it does not make the provider read and later submission atomic. A policy
change at the provider after that read can still affect whether the payment is held. The dashboard
therefore describes the reviewed approval requirement and directs the user to the recorded
outcome; it does not promise a hold. Closing this interval requires a provider-enforced transfer
precondition, whose deployed behavior has not been established. Existing invoice and plan paths
retain their own bindings; they do not use the dashboard confirmation contract.

**Proposed scope change, pending acceptance: no unshield for payouts.** Payouts are confidential
transfers between confidential balances, so the treasury keeps no public reserve and exact-shortfall
unshielding isn't built. The
provider documents that a confidential transfer's recipient must have confidential intents enabled; a
payee without it would need an explicit public payout, built then and bound to its approved terms.


### Dashboard strategy configuration (offline-tested)

Reviewed strategy saves and schedule mutations share a single-host configuration lock. Saves compare
the current strategy digest and persist schedule-off before replacing the strategy. Enablement requires
an unchanged digest, policy in force, a live held Treasury grant matching the strategy, and no unresolved
operation; the digest is checked again after asynchronous reads. Stop is independent of provider reads.
The Treasury app binds an open enable confirmation to its reviewed digest and displayed terms. A
changed digest or unavailable readiness invalidates it until the user cancels and reviews again
(the Treasury app's `test/browser/strategy.cjs`, offline browser fixtures).
After a failed strategy or schedule refresh, the Treasury app labels readiness unknown rather than
presenting cached authorization as current. Cached strategy details remain available for editing,
and the stop control remains available. Recovery restores the label after successful reads.
Treasury owner preparation requires a reviewed saved digest, derives the grant suffix server-side,
and requires the schedule off. Grant completion does not switch it on. The legacy settings endpoint
uses the same controls and refuses unreviewed changes or combined change-and-enable requests.

These controls are tested offline in `test/strategy-controls.test.ts`; they add no rule to `authorize.ts`
and do not replace dispatch checks. They coordinate dashboard configuration on one host, not manual
file edits, provider changes after observation, or multiple executors. Previously submitted operations
may finish after stop. The new workflow has not been deployed or observed on mainnet.


### Intermediate run observations (offline-tested)

Intermediate stage events and provider-accepted submission observations are supplementary evidence.
A stage returning does not prove success; a provider operation ID does not prove settlement.
The submission observer runs only after the journal records acceptance, and exceptions in it do
not prevent status tracking. Failure to write progress stops that tick's progress writer, flags
incompleteness when the end can be saved, and does not change authorization or recovery decisions.
A crash before that flag can be saved leaves an unfinished tick; no finish is inferred.
`test/autopilot.test.ts`, `test/plan-recovery.test.ts` and `test/run-progress.test.ts` cover these
boundaries offline. The UI polls snapshots; transport latency and deployed behavior remain unverified.

### Review corrections: refusal evidence and approval identity (offline-tested)

Offline regressions reproduced four local gaps: unstructured HTTP errors resolved claimed sends;
approval checks accepted policies that had removed USDC or transfers; approval status responses
could name another operation; and a separate instance could inherit `AUTOPILOT=on`.

The corrected submission classifier accepts only recognized non-execution codes: `policy_denied`
and `spend_budget_exceeded` on 4xx responses, and the existing `route_unavailable`, `quote_unavailable`
and `spend_price_unavailable` exceptions on 5xx responses. Every error entry must have a recognized
code and a status matching the HTTP response; retryable entries remain ambiguous. Generic HTML,
empty responses and unknown codes leave a claimed operation unresolved and block replacement sends.
Invoice reservations remain held. This is conservative: even a genuine refusal with a new code
requires investigation before its non-execution semantics can be accepted. These changes do not
reclassify historical refusal records or establish remote deduplication guarantees.

Approval preparation and submission now also check the current policy's asset and transfer
permissions and require the status response to name the requested operation. Rejection retains
its identity checks without requiring the policy to permit payment. These checks do not establish
that the provider rechecks the policy at release or prevent changes after the final local read.

When `ENV_FILE` names a separate instance, schedule enablement comes only from that file;
an inherited `AUTOPILOT` value is ignored. An absent setting stays off, while explicit on/off
settings in the instance file are preserved. The default `.env` instance keeps its existing
environment behavior. Before rollout, check each separate instance's saved setting; do not
copy a shared `AUTOPILOT=on` into it merely to retain inherited behavior.

Coverage is in `test/money-safety.test.ts`, `test/invoice-durability.test.ts`,
`test/two-machine.test.ts` and `test/env.test.ts`. No state conversion is required; preserve
the existing state directories and follow the stopped-executor rollout in
[operations](operations.md). These corrections have not been verified on a deployed host or mainnet.

### Journal integrity and directory durability (offline-tested)

The operation reader validates lifecycle fields and transitions before recovery or dispatch
can use them. Orphan records, duplicate preparations or claims, unsupported versions, conflicting
correlation IDs, terminal rewrites and a `never_submitted` refusal after a submission claim stop
the read with a line number. The reader leaves the evidence unchanged. Legacy records remain
readable, including combined request/outcome records and correlation IDs without status; legacy
preparations never become proven unsent. `test/journal.test.ts` covers rejection, preservation and
compatibility, alongside the existing real-process crash tests. Additional metadata on recognized
records is ignored and timestamps remain opaque strings; neither changes submission evidence.
Standalone version-1 authorization snapshots are accepted only after an unversioned preparation,
as historical metadata. They cannot establish submission, settlement or a refusal. Orphan snapshots,
unknown versions, malformed payloads and snapshots mixed with lifecycle fields stop the read.
This compatibility is offline-tested in `test/journal.test.ts`; historical shapes beyond those
recognized by the reader remain unverified and require retained-state validation before rollout.

Plan execution markers now sync their file and directory entries before execution proceeds.
Journal appends and atomic replacements sync their containing directory. Journal and plan directory
setup requires an established parent and syncs the state directory’s entry on every call, including
a retry after a failed sync or a restart. Existence alone is not evidence of durability. Ordinary
writes sync only their containing directory; no operation walks to the filesystem root.
Other callers must establish durable state directories before relying on these write helpers. Sync failures propagate; a created plan marker is retained even on
failure, so an uncertain claim cannot be retried by deleting its marker. A replacement can become
visible before directory syncing fails: an exception does not prove that the previous file survived.
`test/synced.test.ts` injects directory-sync failures against real files and checks these boundaries.
`test/plan-recovery.test.ts` verifies that repeated journal-directory sync failures send nothing,
and execution resumes only after the sync succeeds.
These tests do not simulate hardware power loss or establish the production volume's durability;
the filesystem and storage must honor successful sync calls. Unsupported directory syncing fails
the write rather than silently weakening it.

No state format conversion is needed. Before rollout, stop the executor, preserve all state
directories listed in [operations](operations.md), and validate its journal with the new reader
on a backup copy. Inconsistent history requires investigation or restoration from verified evidence;
do not delete records or execution markers to make validation pass. Older formats and corrupt
records are distinguished explicitly, not automatically repaired.

Provider timelocks and scheduled release remain an open enforcement question. The local
authorization path does not hold every delayed action and does not inspect the provider's
scheduled-execution queue. The architecture text now states this limit; no new timelock rule
or claim about deployed release-time enforcement is introduced.


### Self-service setup boundary (offline-tested only)

Hosted reservations bind one owner and area before provider creation. A verified wallet may reserve
its own setup; a DAO member also needs proposal permission. Reservation is not owner approval.
Creation uses the existing verified owner-intent lifecycle, and another open creation blocks a new
one on that instance. The 32-instance cap bounds local reservations; it does not establish capacity
under load, fair admission or protection against many wallets exhausting that cap. Mainnet creation
through both owner types, and payee invoice intake for newly reserved Payables agents, remain
unverified or unimplemented respectively. See `docs/operations.md` for preservation and host limits.


## Shared machine access candidate

The local shared access implementation is documented in [Agent access](agent-access.md). It delegates
independent read, chosen-swap/rebalance preparation, saved-plan execution and sweep permissions to a host-, owner-
and provider-agent-bound credential. DAO machine issuance and use remain refused; existing records
can be restricted by a DAO member with freshly verified management rights. The existing execution
path is unchanged. Credentials have no separate spending budget; the scheduled autopilot per-run
ceiling does not limit external saved-plan execution.

This is offline-tested, not deployed or mainnet-observed. Chosen-swap `externalPlan` quotes and saves
exact ordered swaps, retaining policy/strategy bindings and cost limits; execution uses the existing
guarded saved-plan path. The Treasury skill/client uses shared authorization with no rebalance fallback.
There is no verified DAO delegation approval, OAuth/MCP interface, or distributed revocation/fencing. Local
simulated-provider tests cover client process termination after a first success and lost swap responses:
no duplicate submissions occur, and unresolved outcomes block new sends. Killing the client does not
cancel an admitted server execution. These tests do not establish real-provider crash/settlement
behavior. Restoring old credential state can restore revoked authority:
retain the latest `.machine-auth/` state across rollback, or disable machine routing until credentials
are revoked or expired. Provider concurrency guarantees remain unverified.

## Standalone payee frontend candidate

Invoices' extracted frontend and shared backend additions are offline-tested candidates, not hosted
or mainnet observations. Compatibility is checked using declared payee capabilities; it is not
proof of UI behavior or a signed release manifest. The frontend asset service is a trusted release
source and receives no session cookies or API traffic. Its independent rollout/rollback must retain
old hashed assets for open pages. There is no automatic publication, distributed state fencing or
Module Federation runtime integration in this change. Compensation adds private SQLite records and
an initialization marker under `.invoices/`; restore both with the existing state, never an empty
allowance. New isolated payouts require exactly the approved observed funding before first submission;
accepted or unresolved invoices retain their original identity. See docs/invoices-extraction.md.
