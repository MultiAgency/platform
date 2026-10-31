# Treasury

A treasury agent rebalances the DAO's treasury toward its target on its own: it reads balances,
quotes every swap, and executes only inside the per-asset caps and USD budget the DAO signed. Idle
funds stay in the confidential balance. Mainnet: `agentic.sputnik-dao.near`'s treasury agent.

## How each requirement is counted

Every requirement is one of its brief's use cases or outcomes in the Agent Connect experiment catalog, in
the catalog's words where they fit, split where the catalog mixes two kinds:

- A **capability target** describes intended behavior (rebalances, pays an invoice).
- A **safety target** describes an intended constraint (pay an unagreed payee, exceed the budget), and identifies the control or limitation for a
  misbehaving agent: **the signed policy** (the provider refuses under the policy the owner signed, or the
  chain does, as with a DAO's vote), **our server** (only this repo's code holds it, so a user has to
  trust it), **not possible** (nobody can enforce it here), or **nothing yet**.

Every row says how it's known: **observed on mainnet**,
a dated observation with real funds, on this area's own agent or on another (the other area's, or an
isolated test agent), and the row says which; **tested offline**; **per pinned provider source, with deployed behavior unverified**; or **not yet**. The provider and its
custody are still trusted; [enforcement](enforcement.md) sets out how far, and what isn't established.

The app shows only this area's running brief. Public cards show its evidence coverage by observation
scope and its known limitations, without a completion score. The shared signed-in workspace leads
with tasks and status; each area keeps its known limitations beside its detailed evidence.
Mainnet observations do not establish every guarantee. Public cards also show its capability and safety targets,
controls and evidence stages; members follow **Inspect evidence and limitations** on Portfolio
for the same requirements with their evidence. Roadmap briefs remain below for planning and are
not displayed in the app. Both presentations use the [canonical inventory](../evidence/inventory.ts).
The tables below are generated; edit the inventory and run `pnpm evidence:write`.
`pnpm test` rejects drift.

<!-- BEGIN GENERATED: requirements -->
<!-- Generated from evidence/inventory.ts. Run pnpm evidence:write; do not edit here. -->

## 02 Agentic Treasury Management

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | Rebalances to target allocations on a schedule | — | Observed on mainnet | The autopilot executed a rebalance alone, its plan bound to the strategy digest, 2026-10-12 16:17Z (test/autopilot.test.ts, test/rebalance.test.ts) |
| Safety target | Can't exceed per-asset limits | The signed policy | Observed on mainnet | The policy caps every asset per transaction, hour, day and month. On the treasury agent, a transfer over its hourly cap was refused with policy_denied (policy revision 8, 2026-10-11); a swap over the monthly cap was refused on an isolated test agent, 2026-10-13 |
| Capability target | Quotes every route before executing | — | Observed on mainnet | Two quoted legs executed on the treasury agent, 2026-10-12 20:36Z (test/rebalance.test.ts, test/plans.test.ts) |
| Capability target | Shows budget headroom ticking down with each dispatch | — | Observed on mainnet | On the treasury agent, a Run now swap took the daily budget left down by its value, shown as before and after under Automations' Latest run, 2026-10-14 00:50Z. The Overview and each run show the window with least left (test/budget-window.test.ts) |
| Safety target | An over-budget operation is refused; earlier operations in its run may complete | The signed policy | Observed on mainnet | Refused with spend_budget_exceeded, nothing moved, on the treasury agent, 2026-10-12 13:57Z and 14:06Z |
| Safety target | Can't spend more than the USD budget, even with simultaneous requests | The signed policy | Observed on mainnet, on another agent | Five simultaneous swaps on an isolated test agent: one settled, the rest refused, no overshoot, 2026-10-13 (one trial) |
| Capability target | Sweeps idle stables into the confidential balance | — | Observed on mainnet | A small USDC deposit to a public deposit address landed in the treasury agent's public balance; the dashboard's Sweep (the same sweep the autopilot runs each tick) shielded it, and nothing was left public, 2026-10-14 00:33Z to 00:39Z (test/autopilot.test.ts) |
| Safety target | The resting position can't be traced on chain | Our server | Observed on mainnet | No public NEAR Intents balance on chain and all three assets confidential, read-only check, 2026-10-13T23:03Z. Kept so by our deposits' and swaps' requests: the policy allows public swaps and unshield (docs/enforcement.md). Funds still can't leave: the destination list is empty |

### Known limitations

- Whether simultaneous requests can exceed asset limits or the USD budget remains unverified.
- This server checks which assets can be bought; the provider does not.
- This server requests confidential swaps, but the policy also permits public swaps and moving funds back to a public balance. A confidential balance does not establish protection against every form of tracing.
- The agent has not yet run unattended for days.

## 09 Adaptive DCA (roadmap)

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | Daily buys of listed tokens, sized between a floor and a cap by a signal | — | Not yet | Not built: the strategy is a target allocation |
| Capability target | Pauses on a cold streak or regime change | — | Not yet | Not built |
| Safety target | A token outside the list can't be bought | Our server | Tested offline | The provider checks only the asset a swap spends; our server refuses buying an unlisted one (test/authorize.test.ts). A swap into an unlisted asset succeeded through the API directly, 2026-10-10 |
| Safety target | A buy can't exceed the per-cycle cap | The signed policy | Not yet | The policy's per-transaction and hourly caps would stop it; DCA isn't built |

## 18 House Money (roadmap)

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | The principal moves to a safe account once gains cover it, exactly once | — | Not yet | Not built: the treasury agent's policy lets no funds leave |
| Safety target | Drawdowns can't touch the banked principal | Nothing yet | Not yet | Not built |
| Safety target | Nothing comes back from the safe account | Nothing yet | Not yet | Not built |

## 08 Bitcoin treasury (roadmap)

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | Inbound BTC lands in a public checking balance from any sender | — | Not yet | Not built: no BTC asset, and deposits land confidential |
| Capability target | One-time deposit addresses with refund destinations, reconciled from provider records | — | Not yet | Partly built: one-time deposit addresses and reconciliation from the provider's history exist; no refund destinations |
| Capability target | A scheduled sweep to the confidential treasury, within a cap and a delay | — | Not yet | Partly built: every tick shields public balances; no separate treasury and no delay |
| Safety target | An oversized sweep is refused at the per-transaction cap | The signed policy | Not yet | The policy caps each transaction; not shown for a sweep |
| Capability target | The owner can cancel a sweep during the veto window | — | Not yet | Not built: needs the provider's timelock tested on mainnet first |

<!-- END GENERATED: requirements -->

## Gaps

- Not listed above: the catalog's "unshielding exactly what a payout needs". Payouts are confidential
  transfers between confidential balances, so the treasury keeps no public reserve; a payee who can't
  receive confidentially would need a public payout, not built ([enforcement](enforcement.md)).
- The running brief’s [known limitations](#known-limitations) cover enforcement and unattended
  operation. See [enforcement](enforcement.md) for the supporting assessment; outside the dashboard,
  warnings reach the owner through optional Telegram notices (README **Notifications**).

## Run-log adapter and export (offline-tested)

`src/agui.ts` projects a tick and its agent-scoped journal history into a private recording, validated
against the pinned `@ag-ui/core` 1.0.3 event schemas. New exports use envelope version 3 and declare
AG-UI protocol 1.0 separately from the SDK version. Versions 1/2 remain readable as legacy archives;
they are not retroactively certified as conforming event sequences.
It imports evidence types only and makes no provider calls, writes, or money decisions.
`src/journal-history.ts` reads a bounded snapshot of the existing JSONL journal without changing it;
malformed lines and unavailable history appear as gaps. Only explicit fields enter the recording,
with asset display data labelled by its supplied observation date.

The adapter preserves the outcome recorded at tick end. Later journal observations appear separately;
provider `FAILED` is still a provider observation, not independent proof of nonpayment. Journal
timestamps describe local recordings, not provider execution times. Stage durations are not invented,
and a historical tick without an end produces only its recorded start. New ticks add recorded
stage transitions and provider-accepted submissions before their end, via a supplementary progress
file. The before/after books and quoted plan still become available at tick end.
See [integrated run updates](live-run.md) for the offline-tested behavior and limits.

Version 3 validates lifecycle order as well as event shapes. A recorded end with an open stage
emits `RUN_ERROR` and an explicit progress gap, never an invented `STEP_FINISHED`. A recorded run
failure also emits `RUN_ERROR`; its original outcome, refusal and rejections remain in metadata.
Failure detection follows the current producer's `Failed: ` outcome prefix when no refusal is
recorded. It is not inferred from operation statuses; the persisted tick format has no separate
failure enum. A missing tick end stays open. A normally completed refusal may use `RUN_FINISHED`
once all observed stages have returned. These rules follow the
[AG-UI 1.0 lifecycle specification](https://docs.ag-ui.com/spec/1.0/events/lifecycle) and are checked
against an independent lifecycle consumer in offline tests; no live client transport is implemented.

`test/agui.test.ts` and `test/journal-history.test.ts` cover synthetic success, refusal, partial and
unresolved execution, interrupted ticks, late reconciliation, missing timing, conflicting operation
associations, schema validation and read-only file access. No real recording has been validated by
this change. The Treasury app continues using its existing timeline reads for current status. Its
optional **Inspect recording** view steps through historical observations with a selector and
Previous/Next controls, without timed playback or a live stream. It shows missing timing and source
gaps, and keeps later journal observations separate from the run's original outcome. It cannot
replay or authorize an operation. The earlier Treasury prototype's `test/recording-view.test.ts` checks version,
identity, size and completion semantics, and its `test/browser/run-history.cjs` checks synthetic recording behavior once,
including identity refusal and separate later settlement, and resizes the loaded inspector to
320px, 390px and 1280px. All requests are intercepted.
These are offline checks, not verification of a deployed inspector or a real recording.

Members can download a recording from the executor using `autopilot.log({ tickId? })`: the selected
tick, or the latest recorded tick when no ID is supplied. The server scopes the read to its configured
agent, and the gateway checks per-agent membership before forwarding it. Export responses carry
`Cache-Control: private, no-store`. The endpoint rejects missing ticks, invalid or duplicate selected
records, and evidence files over 8 MB or the line limit; it never substitutes the latest tick for a
missing selected ID. Approve-only hosts refuse export. Current token metadata is optional display
enrichment, dated at export, and failure leaves explicit gaps rather than changing historical amounts.
`test/run-log-export.test.ts` and `test/gateway-denial.test.ts` exercise these behaviors offline.

To save a private recording, follow **View treasury runs** from Portfolio Overview, open **Run details**,
then choose **Inspect recording** or **Download recording**. Strategy links to the same full run view. **Run to view** lists
retained runs, including quiet runs. The download requests that run's exact ID and saves a JSON file locally;
keep real files in `~/agencies/proto-releases`, never the repository or public assets. A tick without
a recorded end downloads as incomplete, containing its known start and any recorded intermediate events. Downloading does not run or
reconcile a tick. The browser download flow has been built, but has not been checked on a deployed host.

## Next (planned, not built)

- **Undo window (planned).** Investigate provider `timelock_ms`, scheduled-execution listing and
  cancellation to give the owner a veto window before an autopilot swap executes. Release-time checks
  and cancellation behavior need verification before implementation. Today, an observed queued
  execution remains unresolved and blocks new sends, but this server does not reject a policy merely
  because it has a timelock and does not inspect the provider's scheduled-execution queue
  ([architecture](architecture.md#how-the-money-path-stays-safe-on-one-host)).


## Strategy setup in the dashboard (offline-tested)

Strategy shows the saved Treasury strategy, with swap limits on demand. An account with settings
permission on the executor edits allocations, schedule and ceiling, reviews them, and saves with the schedule off.
Saving needs no existing grant. A stale save preserves the draft and requires comparing the current
strategy before reviewing again. The owner then reviews the exact saved strategy and issues its
digest-bound grant through the existing wallet or DAO flow. Prepared/submitted owner actions remain
accessible in Activity; a grant outcome is neither schedule enablement nor payment settlement.
A matching live grant can be reused or renewed before expiry through **Review grant renewal**,
with the schedule off and the same saved strategy digest. Renewal uses the existing owner-signature
flow; it requires no strategy edit or prior grant revocation and does not enable the schedule.
An account with execution permission explicitly enables the saved strategy afterward.

Server controls serialize dashboard saves and schedule changes on this host, persist off before
strategy replacement, reject stale digests, and check policy, held grant and unresolved operations
before enabling. Stop writes only the schedule flag and remains available during failed provider
reads. It prevents future scheduled ticks; a tick already started can submit further operations, and
submitted operations may finish. **Run now** remains available with the schedule off. The old settings
endpoint cannot combine settings changes and enablement. Approve-only
instances cannot configure strategies; Payables has no Treasury setup and retains stop for an
existing schedule. No state format migration is required.

`test/strategy-controls.test.ts` covers server refusal/failure paths, and the earlier Treasury prototype's `test/browser/strategy.cjs`
covers synthetic wallet/DAO workflows. This is offline-tested behavior, not deployed or mainnet-observed.
Dispatch still authorizes every operation; the settings lock is not distributed fencing and does not
coordinate manual file edits or make provider observations atomic with subsequent sends.

Planned swaps require fresh input/output valuation before each send, including before an automatic
shield. Autopilot also checks the sum of prior submitted swaps for that plan plus the proposed swap
against its ceiling; shields are excluded and refunds do not replenish the limit. Unknown valuation
refuses. The journal supplies these existing records, so no counter migration is needed. This is
offline-tested in `test/planning-valuation.test.ts`; it does not establish settlement-time cost or
provider budget accounting. See [execution valuation](enforcement.md#how-each-claim-is-known).
