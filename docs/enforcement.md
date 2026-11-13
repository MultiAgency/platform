# Enforcement: what the signed policy guarantees today

What this prototype can claim about staying inside the owner's policy, the evidence for each part, the
gaps, and what a stronger claim would need. Dated runs are in the [mainnet log](mainnet-log.md). Further source pins and evidence are in the release record
(GUARANTEE.md), kept privately outside this repository.

**Claim:** "The prototype performs autonomous rebalancing with application checks and provider-enforced
limits. Output-asset enforcement is local. This executor sends one operation at a time and follows each to a settled
status before the next, so its own concurrent requests can't race the provider's counters (offline-tested). Strict
cumulative per-asset limits and USD-budget atomicity against every other sender rest on the provider and are not
independently verified." See [spending limits under concurrency](#spending-limits-under-concurrency).

## The envelope
The owner-signed policy configures the provider controls below. The API documents signing the complete
policy; independently verifying the binding from its plaintext to the signed payload remains open.

- **Allowed input assets.** The provider's `assets` list restricts what may be spent. This executor
  additionally requires swap outputs and limit-order acquired assets to be in the same list; that
  stricter check is local.
- **Permitted actions.** `actions`, with shield and unshield under `confidential`, and transfers only to
  `destinations`.
- **Per-asset spending caps.** Per transaction, hour, day and month. A swap spends its input.
  OutLayer's pinned tests show the hour and day counters as UTC calendar periods, not rolling windows
  (tests/velocity_accounting_e2e.sh:40–41); the monthly bucket key `monthly:%Y-%m` comes from coordinator
  code since removed, so its current form is unknown. The deployed version is not established.
- **A cross-asset USD budget.** Shared by every grant. The Agent API documents fixed daily, weekly and monthly
  periods, each counted from when the applied policy turned that cap on, not rolling windows; so up to twice a cap
  can move across a reset ($100 just before and $100 just after under a $100 daily cap). A smaller shorter-period
  cap, per-asset hourly limits or a timelock bound that burst
  ([skills@72482e3, policy reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/72482e34acaf16236b74c85f64243dba73e70c8d/near-intents-agent-api/references/policy.md),
  per provider docs; reset edges not observed here).

Outside the envelope:
- The strategy (allocation target, cost cap, per-run ceiling, cash floor): an application rule bound to the owner's
  approval by the grant label. The provider's policy has no balance floor and rejects unknown fields, so the cash
  floor is the platform's check alone (see "Cash floor" below).
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

## Recent checks

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

## Status
| Constraint | Status |
|---|---|
| Output asset | **Documented provider limitation relative to our stricter requirement.** A direct-API mainnet swap into an asset outside `assets` succeeded (2026-10-10, [log](mainnet-log.md#a-swap-into-an-unlisted-asset-2026-10-10)). The provider now explicitly documents `assets` as tokens the agent may spend; swaps may buy unlisted tokens ([skills@8e03b0e, policy reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/policy.md)). This agrees with the input-only check in the pinned policy engine (wallet_policy.rs:467–476, :1011–1014). Our executor retains the stricter output check (`outputAssetRefusal`, src/policy.ts); provider output-asset enforcement is not claimed. |
| Cumulative per-asset caps | **Serialized per wallet, per upstream tests; strict enforcement unproven. A monthly-cap refusal is observed:** on an isolated agent, after a settled small USDC swap, the identical request was refused with `policy_denied` and nothing dispatched; only the monthly cap, set below the two swaps together, was exceeded (2026-10-13T03:27Z; [mainnet log](mainnet-log.md#isolated-test-agent-shield-and-monthly-cap-2026-10-13t0327z)). Sequential, not concurrent. Upstream end-to-end tests show that of two simultaneous spends against one limit exactly one passes, that usage is written while the wallet is held, that every caller shares one usage row, and that a crash leaves an operation uncharged until a later read repairs it and charges it once (outlayer@b8c58c0 tests/wallet_concurrent_spend_e2e.sh, velocity_two_doors_e2e.sh, stuck_request_repair_e2e.sh). The API specification documents that a swap holds the wallet for its duration. Unknown: whether new admissions are blocked until a crashed operation is repaired, how the lock coordinates across service instances, and which version is deployed. The coordinator is private. **This executor's own concurrent sends: offline-tested** (`test/spending-limits-race.test.ts`, [below](#spending-limits-under-concurrency)). Provider questions Q1, Q3, Q4. |
| USD budget | **Held in one concurrent trial; mechanism unverified.** Five simultaneous identical small swaps sent directly with one grant, with room for two: one executed, one got `wallet_busy`, three got `spend_budget_exceeded`, and the budget did not overshoot (isolated agent, 2026-10-13T03:32Z; [mainnet log](mainnet-log.md#isolated-test-agent-usd-budget-under-concurrency-2026-10-13t0332z)). Admission was more conservative than the reported remaining budget. One trial, one grant, one host: not proof of atomicity across grants or instances, or after a crash. The provider documents charging "atomically at dispatch" (skills@5d76111 `references/policy.md`:80); the API server is private. **This executor's own concurrent sends: offline-tested** (`test/spending-limits-race.test.ts`, [below](#spending-limits-under-concurrency)). Provider questions Q2, Q3, Q4. |
| Signed policy binding | **Not independently verifiable.** The API's `policy_hash` is reproducible: sha256 of the returned policy with sorted keys (recomputed on 2026-10-13 for all 15 returned revisions: treasury 1–11, payout 1, isolated agent 1–3). The on-chain `agent_policy_hash` is not a function of the policy (two treasury revisions share one `policy_hash` but carry different `agent_policy_hash` values on chain), and the public `store_wallet_policy` takes no such argument. The enforced policy is stored encrypted to a custody keystore key and signed by the custody wallet key, not the owner, so it proves neither that the owner signed those terms nor that no owner authorization exists elsewhere. A NEP-413 `update_policy` message, captured unsigned on the demo host, carries the complete plaintext policy, revision, agent, owner and domain, so an owner can read what they sign for API-enforced edits; whether the provider-enforced part matches it is the open question. A NEP-366 `policy_update` (an asset change), also captured unsigned, signs only a delegate to `store_wallet_policy` carrying `encrypted_data`: the readable policy appears only in the unsigned preview, so for those edits the owner signs ciphertext. What the message's `target_id` identifies is unknown. Captures are in the private release record. |
| Execution artifact | **Coordinator trust assumption, in pinned source.** For swaps and confidential transfers (including payouts), the keystore checks only that the signed message is addressed to `intents.near` or `intents.far`, then signs it unparsed (keystore-worker/src/api.rs:5729–5786). Our approval check binds the intended payment locally (payee, amount, asset to the provider's request hash), and the owner's approval binds whether the operation runs; that the final signed artifact carries those terms depends on an honest coordinator. Deployed behaviour unknown. |
| Operation audit proof | **Unavailable on the sampled deployment.** At 2026-10-13T04:10Z, all three sampled successful operations returned HTTP 501 `transparency_log_disabled` from the demo API. The run is in the [mainnet log](mainnet-log.md#policy-signatures-and-operation-proofs-2026-10-13t0410z); operation ids and captures are in the private release record. Even an available event inclusion proof would not by itself establish signed spending bytes, complete history or atomic enforcement. |
| Input asset, actions, frozen, per-transaction cap | Enforced in the provider's TEE, per its source. The deployed version is not established. |
| Destinations | Enforced by the Agent API, per its docs. One mainnet refusal was observed. |
| Deposit conversion | **Scope question, not a known spending bypass.** Public API docs explicitly say deposits need an API key, no grant or owner signature, and do not spend treasury funds. Whether the agreement restricts conversion targets, and whether that is enforced, remains open. |
| Shield under a non-empty `only` list | **Observed working on an isolated agent.** Under a destination list copied byte-for-byte from the treasury's (revision 11), a shield of its public wNEAR succeeded and charged no USD budget (2026-10-13T03:27Z, an isolated test agent; [log](mainnet-log.md#isolated-test-agent-shield-and-monthly-cap-2026-10-13t0327z)). For the treasury agent’s subsequent sweep observation, see the [canonical Treasury requirements and evidence](treasury.md#02-agentic-treasury-management). That observation does not independently establish enforcement under every destination configuration. No `policy_confidential_whitelist_conflict` exists in any public source. |
| Payout withdrawals | **Mainnet-observed on staging 2026-10-30 (wNEAR and USDC paid without a vote; a held one rejected; the USDC registration refusal) ([mainnet log](mainnet-log.md)); stack-tested with a simulated provider.** A payout request may withdraw wNEAR (arriving as native NEAR, per the provider's docs) or USDC that the policy's `assets` include (else `asset_not_allowed` before sending: the provider's own refusal of an asset uses a code not proven here) to chain `near`, from the confidential balance, without a memo, to an exact `withdraw` destination of an `only` policy, covered by the balance not already held and not repeating a held payout (`authorize`, purpose `payout`; invoices stay confidential USDC transfers). Before anything is recorded, a USDC withdrawal's recipient must be registered (NEP-145) on the USDC contract, read at final finality (`recipients.ts`), else `recipient_not_registered`: the NEAR Intents docs say a NEP-141 withdrawal to an unregistered NEAR account fails, and the Agent API's withdraw request has no registration option (provider SDK 0.7.2 types; provider skills `bedda21`). This is conservative: whether the confidential path, paid by 1Click, registers the receiver itself is unobserved, as is how a failed delivery would be reported. The read's answers are mainnet-observed ([mainnet log](mainnet-log.md#token-registration-reads-on-the-usdc-contract-2026-10-29t1444z): an unregistered account answers `null`); the refusal is offline-tested. An asset a payout may not withdraw is refused by `authorize`, not read. A registration can't be withdrawn between the read and the send by anyone but its holder, which the check doesn't guard against. The provider enforces the policy itself, including destinations. Per its docs (skills repo, 2026-10-28): a withdrawal is public on chain, and one paid from the confidential balance goes through 1Click, so the payee may receive less than the amount (the provider values the fee as `amount` minus the quote's `amount_out`). **Approving a held withdrawal (offline- and stack-tested; not mainnet-observed):** OutLayer's approval hash is sha256 of the canonical operation (`shared-tee-helpers@f75a74e`, `wallet_policy::request_hash`, where a withdrawal to NEAR is `kind: "withdraw"` with `to`, `amount`, `token`), and the Agent API's approval for a confidential withdrawal to NEAR was observed on mainnet (2026-10-30, one approval): `request_type` `confidential`, `request_data` with `to`, `chain`, `token`, `amount` and `destination_asset`, and a `request_hash` equal to sha256 of the canonical `{ amount, chain, flow: "withdraw", kind: "confidential", to, token }`, the transfer's shape with `flow` `withdraw`. The vote is checked like a transfer's (`src/payment-approval.ts`, `test/authorization.test.ts`, `test/e2e/app-access.spec.mjs`): the hash is recomputed from `request_data` with `flow` `withdraw`, the chain must be `near`, the current policy must still permit `withdraw`, the asset and that exact withdrawal destination (`authorize`, purpose `approval`), and a withdrawal this instance recorded must match its record. `destination_asset` isn't covered by the hash, so the owner's signature doesn't bind what the payee receives: the approval is refused unless it reads as the token withdrawn (the held wNEAR withdrawal observed on 2026-10-30 named its token there; one whose `destination_asset` differs is unobserved, [mainnet log](mainnet-log.md#payout-withdrawals-on-platform-staging-2026-10-30-utc)). It is also refused if the provider's request names any field outside the set observed then (a memo, say: never sent by this platform, and not hashed). That the executed withdrawal delivers it rests on the coordinator, as for the execution artifact above. Rejecting one releases nothing and needs only the identity checks. An approve-only copy lists held withdrawals from the provider's history too (`src/payouts.ts`, `test/payout-review.test.ts`). Treasury and autopilot sends never withdraw. The journal's method `withdraw` is new: a build before it can't read a journal holding one ([operations](operations.md)). |

## Recovery limitation

G14: response loss after acceptance can leave a withdrawal unknown without a correlation ID.
Preserve its committed budget and never replay it. Automatic lookup recovery remains unverified;
see the [provider investigation and Paperwork handoff](g14-provider-recovery.md).

**Provider SDK 0.8.2 (introduced in SDK 0.5.6, 2026-11-10).** The dependency and lockfile pin 0.8.2 exactly.
Official SDK source `416597b0c63a426b225b98b6d175c03bfb6a7947` adds limit-order methods and signed 1Click
quote inputs for native EVM/Solana sign-intent. The tagged 0.5.6 and 0.5.7 platform releases expose neither
feature; the 0.5.8 path adds limit orders only. Policy reads/previews accept the provider's `limit_order`
action and price-deviation setting without changing its signed policy or dropping that evidence during unrelated edits.
The transport and existing money methods remain compatible in offline tests. A lost reply still makes one transport
attempt with the original idempotency key. New documented errors, including `invalid_address` at 409 and limit-order
price errors, do not become proven non-execution automatically: attempted sends remain unresolved under the existing
classification. This upgrade does not establish a deployed provider version or new mainnet observations. See
[the source review and compatibility checks](provider-sdk-082.md).

**Earlier provider SDK 0.8.0 (locked in `pnpm-lock.yaml` 2026-11-06; 0.7.3 from 2026-10-30, 0.7.2 from 2026-10-28, 0.7.1 from
2026-10-26): documented refusals not adopted.** No upgrade changes a classification rule. 0.8.0 accepts any non-empty
API key (0.7.3 refused at startup any key that isn't `naa_` and 43 characters), for the partner portal's keys: the
provider retires keys created before the portal with `api_key_retired` (401), and answers `key_verification_unavailable`
(503) while the portal can't be reached. Neither is a proven refusal here: a send refused either way stays unresolved
and blocks this agent's sends until reviewed, as `invalid_api_key` does, so each host's key is replaced with a portal key
before the provider retires the old one ([credential rotation](credential-rotation.md)). When it does was not announced:
on 2026-11-06 at 20:53Z the live API's `invalid_api_key` detail didn't yet name the portal, as 0.8.0's changelog says
the new API's does. 0.8.0's other changes (partner quota fields, operation proofs pinned to a witness checkpoint) touch
nothing read here. 0.7.3's JavaScript is identical to 0.7.2's (compared 2026-10-30); its types add the dry-run
warning code `policy_transaction_limit_exceeded` and an execution's `deposit_seen_at`, and drop `native_balance` from a
deletion preview; none of them is read here. 0.7.2 adds `retryAfterSeconds` to `AgentApiError` (not read here) and
types a budget window's `spent_usd` as nullable: every field is `null` for an uncapped window (provider API #51, its
skills and OpenAPI on 2026-10-28); before, it reported `"0.000000"` there (the provider's own demo stub and tests, changed
2026-10-27). The overview schema required a string, so the agent refused its own overview of a policy with an uncapped
window (found on staging on 2026-10-28). The overview now reports an uncapped window's spend as `"0.000000"` again
(`countedSpend`, `src/budget-window.ts`): nothing is counted against a cap that doesn't exist, and owner apps built on
earlier SDKs keep reading it. Production runs the earlier build, so its overview of a policy with an uncapped window
fails until it gets this one (not checked on production). `src/ops.ts` already treats `policy_denied` and `spend_budget_exceeded` (4xx) and `route_unavailable`,
`quote_unavailable` and `spend_price_unavailable` (5xx) as proven refusals, each only at its listed status class. Per
the SDK's CHANGELOG.md at 0.7.1 (docs, not observed): from 0.7.0, `policy_limit_exceeded`,
`policy_action_limit_exceeded` and `policy_usage_unavailable` on a request that runs now, and `provider_refused`, send
nothing; from 0.6.2, transfer `invalid_address` sends nothing and `near_rpc_unavailable` (retryable, so never a proven
refusal here) sends nothing. They aren't added, so after a claimed submission they still leave the operation unresolved.
If the provider now answers a listed code at another status class, that answer also stays unresolved. Adding them needs
observed provider behaviour and a separate rule decision. `policy_denied` was mainnet-observed as a refusal (2026-10-11 and 2026-10-13,
[mainnet log](mainnet-log.md)) but 0.7.1's types no longer name it; they name `policy_action_denied`,
`policy_destination_denied`, `policy_asset_denied` and `policy_schedule_denied`, which aren't listed, so a refusal under
those codes leaves the operation unresolved. The provider now documents an amount over `limits.per_transaction` as
403 `policy_transaction_limit_exceeded`, refused before anything is recorded
([skills@72482e3, errors reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/72482e34acaf16236b74c85f64243dba73e70c8d/near-intents-agent-api/references/errors.md);
docs, not observed). A payout, invoice or approval over that cap is therefore refused locally before sending
(`per_transaction_exceeded`, `src/authorize.ts`; offline-tested, `test/authorize.test.ts`,
`test/submission-evidence.test.ts`), as an asset outside `assets` already was. An hourly, daily or monthly per-asset
limit can't be checked locally (the provider exposes no per-asset usage), so a payment crossing one still leaves the
operation unresolved until those codes are observed. `quote_unavailable`, which the changelog removes, stays in
`PROVEN_5XX` because the deployed provider version isn't established. Since provider API #51/#54 (skills repo,
2026-10-27), a dry swap quote is no longer refused by the account's rules: it answers 200 with `warnings` carrying the
code the live swap would get. `quoteLeg` (`src/treasury.ts`) returns those codes, and a leg with any code not on the
engine's allow-list (empty today) is left out of a strategy rebalance, refuses an external plan before it is saved,
and rejects a saved plan at its pre-send re-quote before
anything is claimed; an autopilot tick reports the codes and asks the owner once (offline-tested,
`test/rebalance.test.ts`, `test/external-plan.test.ts`, `test/autopilot.test.ts`; not yet
observed on mainnet). A clean dry run doesn't guarantee the live answer. A plan's legs are all re-quoted against the
state before its first leg, so a budget or limit that only a later leg crosses once earlier legs have spent
(`spend_budget_exceeded`, `policy_limit_exceeded`) isn't warned; that leg, or any swap the provider refuses after the
re-quote under a code not listed above, still leaves the operation unresolved. The pre-send balance check (`src/agent.ts`) still
reads the confidential balance rather than 0.7's `available` figure (balance minus queued or timelocked work), so it can
pass a send the provider then refuses with `insufficient_balance`. The ledger's `details.amount_out` is documented as
present only on `SUCCESS` (or a partial `REFUNDED`), so pending swap rows show none. The unresolved treasury
operation recorded with `policy_usage_unavailable` evidence is unaffected: a changelog doesn't establish what happened to
that submission.

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
agent's later sends until reviewed (`test/e2e/shared-payout.spec.mjs`). A send refused by the platform's own checks before
submission leaves the payment prepared on its identity for a later send (owner decision, 2026-10-18;
`test/compensation-http.test.ts`). **Open dependency for making shared the default:** observed provider behaviour for
looking up, or deduplicating, a submission by its idempotency key, so a lost response can be resolved without
reconstruction. Per the provider's docs at [skills@94eff2e](https://github.com/NEAR-Intents-Agent-API/skills/blob/94eff2e835db9c7f554fff22b8c44414eb621357/near-intents-agent-api/references/errors.md) (retry rules 1 and 3), a write whose reply was lost may be retried "with the same `Idempotency-Key` and identical body (safe)", which "replays or reconciles it". That is documented, not observed: one staging run that replays a key and sees the original operation with a single execution could let a lost reply resolve by replay under the money lock. It stays a candidate until that behaviour is observed and reviewed.

**A lost provider reply blocks its executor until reviewed, on every send path (offline-tested; not mainnet-observed).**
This is not specific to shared payouts. Any send through `dispatch` (manual payments, invoice and order payouts, swaps)
whose provider reply is lost is recorded as submission-attempted with no operation ID. It is never sent again, and it
blocks that executor's later sends (`test/journal.test.ts`, `test/money-safety.test.ts`,
`test/invoice-durability.test.ts`). The payout itself stays
reachable: the held-payout list also reads the provider's own history (`src/payouts.ts`, `heldElsewhere`), so the owner
can still approve it by signature and it can settle.

The blocked operation does not clear, even after settlement. `recover()` polls only operations with an ID and reports this
one as "acceptance is unknown… review required" (`src/recover.ts`). The provider's history entries carry the operation ID
but not the idempotency key, so the only link to the recorded attempt would be matching terms and time, which the platform does
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

A payout request's answer relays that distinction rather than deciding it (0.5.5, offline-tested,
`test/payout-requests.test.ts`; not mainnet-observed): a `failed` request carries `neverExecuted`, true only when the
provider's status of that operation, read when answering, agrees with the journal's FAILED and carries
`details.never_executed: true` with no transaction, intent, delivered amount or refund in its details. That is the
provider's statement, which its docs give for an owner's rejection of a held payout; the platform verifies no balance
and sends no replacement. Everything else (a delivery failure, REFUNDED, a missing flag, an unread status) reads false,
which proves nothing. The journal still records status only; `neverExecuted` and `failureCode` are not recorded.

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

**A payout to an unagreed account is refused before sending (offline- and stack-tested, 2026-11-09).** The provider
refuses an unlisted payee with `policy_destination_denied` (mainnet, 2026-10-11, [mainnet log](mainnet-log.md)), which
isn't a proven refusal: sent, the operation stayed unresolved and every later payout of that agent was refused
`unresolved` until resolved. An app's agent that reads untrusted text can be led to make that request: in the
[crash test](crash-test.md), an invoice naming a lookalike payee or an "owner" email naming a "safe" account blocked a
gullible scripted agent's payout agent in 6 of 6 runs (the simulator refused with a generic error, not the provider's
code; neither is proven). `src/authorize.ts` now refuses a payout's transfer to a payee the policy doesn't agree to
(`payee_not_agreed`) before sending, as it did a withdrawal's and an approval's (user decision, 2026-11-09;
`test/authorize.test.ts`); the same runs then blocked no agent. Invoices still leave the payee to the provider.

**A second payout after the first settled (stack-tested, 2026-11-09).** `duplicate_held_payout` refuses a second payout
with the same payee, asset and amount only while the first is held. Once it has settled, a new `requestId` for the same
invoice is a new payout, held for the owner's vote; the vote's text names no payee or amount (see app access). In the
crash test, each "pay again" lie (failed, pending, an `unknown` urging a new `requestId`, a reissued invoice) gave a
gullible scripted agent a second 2 USDC payout when the owner approved every held payout. The owner's vote is the only
check left; nothing here measures owners. With models in place of the scripted agent (2026-11-10/11, simulated
provider, 3 runs per cell), none paid twice with the SDK's `app-server` skill in its prompt (0 of 71), and GLM-5.3-flash,
Qwen3.8-27B, DeepSeek-V4.1-flash and Kimi K3 did in 14 of 46 without it, and in a second run (whose task also asked for
a claim) every model but Claude Opus 5.5 did, in 19 of 72 ([crash test](crash-test.md)). A request that
opts out of the duplicate check (`allowDuplicateHeld`, 0.5.5) is in the same position while the first is still held.
Since 0.5.8 an approve's prepared vote lists this agent's payouts of the same payee, asset and amount in the last 24
hours, read from the provider's history (`payment.repeats`, `src/repeat-payouts.ts`), and the confirm page shows them
beside the terms; a history that can't be read whole says so, never "none". It informs the owner and refuses nothing
(offline-tested, `test/repeat-payouts.test.ts`; browser-tested, `test/browser/approval-confirm.cjs`; stack-tested, a
second payout of the same terms after the first settled names the first, `test/e2e/app-access.spec.mjs`). An app that
has the owner sign the vote in its own page needn't show it.

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
the same invoice. Payment review shows the terms of the payee's newest non-declined agreement with terms
(`termsInForce`, as the server's `termsFor`), which need not be the terms of that invoice; a payee's agreements all
read `agreed` once the policy lists the payee. The offline test (`web/src/features/payables/payment-stages.test.ts`)
covers selecting the newest terms, excluding declined agreements and other payees. It does not establish
agreement-specific enforcement.

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

## Spending limits under concurrency

Platform issue #6. What bounds cumulative spending (per-asset hourly, daily and monthly caps, and the USD budget) when
requests overlap, split by who enforces it.

**This executor (offline-tested).** `test/spending-limits-race.test.ts` starts six sender processes on one host, sharing
the journal and the money lock, and releases them together against a simulated provider in SQLite whose admission is
deliberately not atomic: it reads usage, yields, then admits against that stale read, and charges usage only when the
operation settles (the best-effort behaviour OutLayer documents, below). Six $10 swaps under a $25 daily budget: two
are admitted and four refused `spend_budget_exceeded`. Five 20 USDC payouts under a 50 USDC daily cap: two admitted,
three refused `policy_denied`; a sixth of 30 USDC, over the 25 USDC per-payment cap, is refused here
(`per_transaction_exceeded`) and never reaches the provider. The journal ends with nothing unresolved. Checked by
mutation on 2026-11-09, then restored: with the money lock removed the senders fail (each sees another's claimed send
as unresolved); with the lock and the unresolved-operation check both removed, the simulated provider admits $60
under the $25 budget and 100 USDC under the 50 USDC cap; with the per-payment check removed the payout case fails.
What does it is `dispatch` (src/agent.ts): one send at a time under the money lock, each followed to a settled status
before the lock is released, and an unknown outcome blocking every later send. No local budget or per-asset counter
is involved: the platform still reads no per-asset usage (the provider exposes none) and adds no rule for it.

This bounds only what this executor sends. Another host, a copied grant token, or the grant used directly is
serialized only by the provider (see "Two facts" below). A held payout (`owner_approval`) doesn't block later sends
while it waits for the vote, so this executor can file several held payouts one after another, each admitted before
any settles; per the provider's docs each counts against its per-asset limits from dispatch until it settles (Q4). A provider cap refusal under a code
this platform doesn't yet treat as proven (`policy_limit_exceeded`, `policy_transaction_limit_exceeded`) leaves the
send unresolved and blocks the executor: safe, not smooth ([recovery limitation](#recovery-limitation)).

**Per provider source and docs (pinned commits; deployed version not established).**
- The policy engine's cumulative check is a pure comparison, `spent + amount > limit`, against usage the caller
  supplies; the keystore calls it without usage, so only the coordinator enforces cumulative caps
  (shared-tee-helpers@f75a74e `src/wallet_policy.rs`:10–18, :1082–1104). Per-transaction caps, input assets and
  freeze are stateless and re-checked by the keystore on every signature (:1070–1080).
- outlayer@b8c58c0 `CUSTODY.md`:219–226 calls cumulative clauses best-effort under concurrency ("a burst can overshoot
  a cumulative cap") and :386–388 records usage only post-settle, nothing reserved at acceptance. Its
  `tests/wallet_concurrent_spend_e2e.sh` (same commit, upstream testnet test, not run by us) pins a per-wallet lock with
  a 2-second wait: of two simultaneous spends that jointly exceed a limit, exactly one passes, the other `wallet_busy`
  or `policy_denied`.
- At outlayer@40e9565 (2026-11-09) `CUSTODY.md` is gone, and the docs say both: "the coordinator serializes
  money-moving operations per wallet: the velocity limits need a consistent read-evaluate-record window"
  (`docs/outlayer-custody-advantages.md`:134–138) and "cumulative limits are best-effort under concurrency … a burst of
  simultaneous requests can overshoot one" (`docs/NON_CUSTODIAL.md`:338–341).
- The Agent API documents its own layer above OutLayer: the USD budget "charged atomically at dispatch using 1Click USD
  prices", shared by every grant; per-asset window limits counted "per agent, shared by every grant, at dispatch",
  pending and uncertain actions counting until settled; and a `FAILED` row "only for a request that loses a concurrent
  race, or a timelocked one released over budget" (skills@5d76111 `references/policy.md`:80–86, :99–106;
  `references/concepts.md`:53–55). The same file calls per-asset windows "rolling" (:73) while the USD budget runs in
  fixed periods (:86–92). The API server is private: these are documented, not source.

**Unverified.** Whether the deployed provider holds any of this across grants, service instances and crashes; the
single concurrent mainnet trial (E5) is one grant on one host.

**Provider questions** (drafted here, not posted):
- **Q1 (per-asset caps, E2–E4).** On the Agent API's route to OutLayer, is the per-asset hourly/daily/monthly check
  serialized with the usage write for one agent across every grant and every API and coordinator instance? OutLayer's
  docs at 40e9565 say both "serializes … per wallet" and "best-effort under concurrency": which holds for agents on the
  Agent API, and is the API's own count at dispatch (skills@5d76111 `policy.md`:99–106) the authoritative one?
- **Q2 (USD budget, E5, E13).** Is "charged atomically at dispatch" a single transaction across grants and API instances?
  Which price is charged (the quote's, or the price at dispatch), how is it rounded, and is the charge trued up to the
  executed `amount_in` or kept on `REFUNDED` and `FAILED`?
- **Q3 (window edges, E12): answered per provider docs.** Per-asset hourly/daily/monthly `limits` are rolling windows
  that the Agent API counts per agent, shared by every grant, at dispatch; pending or uncertain actions count until
  settled, and a completed one counts for the full window after completion (skills@0b81bba6 `references/policy.md`:74, :101–105).
  The USD budget runs in fixed periods from the moment the applied policy turned each cap on (daily every 24 h from then,
  weekly every 7 days, monthly on the same date and time in UTC), not rolling, so up to twice a cap can move across a
  reset; a shorter per-asset limit bounds that burst (:89–95). OutLayer's calendar-period test
  (`velocity_accounting_e2e.sh`:40–41 at b8c58c0) is OutLayer's own accounting; on the Agent API's route the API keeps
  these counts. Per docs, not observed on mainnet.
- **Q4 (pending and held work, E8, B6): counting answered per provider docs; a tightened policy still open.** A held
  or queued action counts against per-asset limits from dispatch until settled (skills@0b81bba6 `policy.md`:101–105),
  hard limits are checked before an action is held for the owner (:72), and a timelocked action is judged again when
  released and can end `FAILED` (:88, :106). OutLayer's "nothing is reserved at acceptance" (`CUSTODY.md`:386 at
  b8c58c0) describes OutLayer's own accounting; on the Agent API's route the API counts pending work. Still open:
  whether a cap reduced, a destination changed, a freeze or a revoked grant stops an `owner_approval` payout already
  held. The 2026-10-12 held payouts were committed before their votes, but that doesn't settle it (see "Two observed
  held payouts were committed before approval" below); the keystore re-checks frozen, input asset and the
  per-transaction cap before signing (`outlayer@da5c9ff`).
- **Q5 (crash, E11): partly answered per OutLayer's public tests.** A request the coordinator broadcast but didn't record
  is repaired lazily: the next read of it settles it as `settled_late` and charges the usage counter exactly once
  (`usage_charged`), and one the chain never saw stays `processing` (`tests/stuck_request_repair_e2e.sh`:17–28 at
  b8c58c0). Still open: whether new admissions for that wallet wait until the repair charges it. The coordinator is
  private, and nothing public says. This executor isn't exposed either way: an operation stuck at the provider stays
  unresolved in its journal and blocks its sends until settled, and its status reads are what trigger the repair.

## Two facts that limit any local guarantee
- **One live grant is not one sender.** Any number of processes can share a token. Counting grants fences
  nothing. Our money lock is a file lock on one host. The only cross-host serializer we know of is the
  provider's per-wallet lock (`wallet_busy`); its interval relative to usage recording is unknown.
- **A local journal gives a local guarantee.** It bounds operations this executor sends. It can match the
  provider's envelope only after these are specified:
  - initial usage reconciliation, from the provider's history, for activity before the journal existed;
  - accounting prices: which quote, and whether charges are trued up to `amount_in`;
  - windows: hourly and daily per-asset counters in UTC calendar periods (pinned tests), the monthly
    bucket unknown, USD budget in fixed periods anchored to when each cap was turned on (docs), with edges
    confirmed on the deployed version;
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
     agent-status rules (and their two reads per send) are gone, and sends leave payees to the
     provider. Approvals still check payee and cap against the policy now, since the provider checked
     them under the policy when the payment was requested. From 2026-11-04, at the user's direction,
     every payment purpose checks the per-transaction cap before sending again: the provider now
     documents its refusal under a code not proven here (see the proven-refusal paragraph above).
   - Verified in current local source. Deployed-source correspondence was not established by the public-documentation review; do not infer deployment from these tests.
2. **One grant-using send site, enforced.** Done: test/send-path.test.ts fails if anything but
   `dispatch` → `send` (src/agent.ts) calls swap, transfer, shield or unshield on a grant, or if
   the quote in src/treasury.ts `quoteLeg` stops being `dry: true`.
3. **Verify execution routes.** The credential and route inventory (M1) is
   kept locally, outside the repository (research/enforcement/M1-CREDENTIALS.md). Check which rules
   the Agent API and OutLayer enforce on every route available to the agent, including direct use of
   its grant. Application checks cover only the executor's code path.

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
the USD budget under one concurrent trial (E5, once).

Spending-limit cases (platform issue #6, 2026-11-09; details in
[spending limits under concurrency](#spending-limits-under-concurrency)):
- **E1, closed as a provider limitation:** the provider documents that swaps may buy unlisted tokens
  (skills@5d76111 `references/policy.md`:72), and the pinned engine checks only the input asset, so no upstream
  refusal is expected. The output-asset limit is this platform's alone (A1); the 2026-10-10 success stays as
  historical evidence.
- **E2–E4, per-asset caps under concurrency:** this executor's own overlapping sends offline-tested; across grants,
  hosts and instances, provider question Q1.
- **E5, USD budget:** this executor's own overlapping sends offline-tested; observed once on mainnet; atomicity
  across grants and instances, provider question Q2.
- **E8, tightening the policy while work is queued or held:** partly answered under Q4 (counting per docs; timelocked work
  is judged again at release); whether a tightened policy stops an already-held payout stays unverified.
- **E11, crash points:** this side's are offline-tested (`test/journal.test.ts`, `test/lock.test.ts`); the provider's
  lazy repair is per its public tests, and whether admissions wait for it stays open (Q5).
- **E12, window edges:** answered under Q3 (rolling per-asset windows; fixed budget periods).
- **E13, price and rounding edges:** provider question Q2.
- **B1–B7, the offline accounting cases of an executable model:** no local budget engine is built (see "Resolve with
  implementation and deployment evidence"), so each is either a property of this side's boundary, offline-tested, or
  the provider's. Two fitting admissions that jointly exceed a cap: offline-tested at this executor's boundary
  (`test/spending-limits-race.test.ts`), elsewhere Q1 and Q2. Unknown outcomes: stronger than a reservation here, as
  they block every later send (`test/money-safety.test.ts`, `test/lock.test.ts`). Same-key retries: never made here
  (`test/journal.test.ts`); the provider's replay is the open idempotency dependency under
  [recovery limitation](#recovery-limitation). A crash before the claim: `test/journal.test.ts`. Window boundaries:
  Q3, answered. A policy reduction: Q4, open for already-held work.

Still open outside issue #6: verifying an owner signature against the enforced policy (S1, S2); the credential and
route inventory (M1); retries around timeout and restart (E6); release on proven non-execution only (E7); revoking or
freezing at each dispatch boundary (E9); artifact binding (E14); rolled-back accounting (E15); operation-proof
verification (P1); and the output-asset refusal for plan legs (A2: plan legs and the autopilot purpose are covered
in `test/plans.test.ts` and `test/authorize.test.ts`).

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


## Treasury proposals (offline- and stack-tested)

An app with `treasury` consent proposes swaps; the owner approves their exact terms later by signing `proposalText`;
the app asks for one execution (`src/proposals/service.ts`). Mainnet-observed once, for a DAO owner on platform
staging (2026-11-05, [mainnet log](mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc)):
one proposed swap, approved by DAO vote, executed once above its signed floor. That run found proposals at market
prices couldn't be stored (their record's hash refused a non-integer USD value); fixed in `8ce51c2`. A wallet owner's
approval, a rejection and an execution refused at the pre-send re-quote are not observed on mainnet.
What holds, offline-tested in `test/treasury-proposals.test.ts` with planted faults (each check removed fails a test):
the platform accepts only the owner's NEP-413 signature over the exact text for its host, by a full-access key of the
owner (gateway, `test/app-access.test.ts`); a policy revision or digest, strategy or agent change voids the proposal;
an execution attempt is refused with nothing claimed or sent when a fresh quote is below a signed floor, the provider's
dry run warns, the balance is short, no live treasury grant is held or the policy isn't in force; each swap is sent
with a floor at least the signed one; the proposal is claimed under the money lock after every check, immediately
before its plan's claim, so it runs at most once and a rejection and an execution can't both win; a claimed proposal
with nothing in the journal reads `stopped` and is never resent; a lost provider reply reads `unknown` and blocks, as
for any send. `authorize` and `dispatch` are unchanged: every swap still passes both.

Limits: the approval is the platform's check, not the provider's. Whoever holds the agent's treasury grant can swap
within the policy without it, as with plans. Treasury agents keep `owner_approval` off, since the provider's switch
holds every action of the agent and an approval lasts 24 hours (observed for a transfer); what a provider-held swap's
vote commits to has never been observed. Stack-tested on the stack's own Treasury agent through an app
(`test/e2e/stack-app.spec.mjs`: a price move refused before the claim, one execution, a lost reply never resent, the
strategy-bound grant for `treasury-execute`); not deployed or mainnet-observed. Which wallets show the text in full is
not checked.

`treasury-execute`: an app's `executePlan` runs only while the owner's live grant binds the plan's strategy digest,
checked under the lock before the claim (`src/planning/strategy-grant.ts`). Before this check, a `treasury` send
accepted any `treasury` or `treasury:*` grant and judged cost against the strategy saved on disk, so an app that could
save settings could have raised its own cost limit; the owner's own session is unchanged, and the machine route has the
same check (below).

**Machine-credential plans need the strategy-bound grant.** `strategy/save` is in the `treasury` scope, and a Treasury
machine credential (`tmc_`) executes plans against the strategy saved now. Before this
change, it did so under a plain `treasury` grant, so an app with `treasury` alone could raise `maxCostBps` (at most
1000 bps) and change targets for plans a machine credential then executed, within the policy's caps and budget. Now the
gateway forwards machine calls as `machine:<credential id>`, and `executePlan` from an app or a machine credential runs
only while the owner's live grant binds the saved strategy, checked under the lock before the claim
(`strategyGrantRequired`, `src/planning/strategy-grant.ts`). Offline: `test/machine-routes.test.ts` (the actor) and
`test/treasury-proposals.test.ts`; stack: `test/e2e/stack-app.spec.mjs` and `test/e2e/agent-access.spec.mjs` (refused
under a plain grant, executed after the owner's strategy grant). The owner's own session is unchanged.

Proposals and consents: a proposal is withdrawn, on the app's next call, once the consent it was made under is no
longer among the app's live consents for that agent (the gateway names them on each call); a second live consent (a renewal) withdraws nothing, and
a proposal already claimed or closed answers its own state, never a withdrawal. A read (`proposals/get`, `proposals/list`)
closes an open proposal whose agent or strategy changed as `invalidated`, as approval would, since the agent holds both;
a changed policy, which the provider holds, is found at approval and execution only. The open-proposal limit is counted
without a lock, so concurrent proposals can pass it slightly; one unreadable proposal record fails proposal calls for
the whole agent (closed, not open). The owner's approving key is checked when the approval is relayed, not again at
execution.

**"Run now" through an app (0.5.1, offline-tested).** Under a `treasury` consent, `autopilot/tick` runs one autopilot
pass: the same guard as the schedule (one tick at a time), and it swaps only under a grant whose label binds the saved
strategy (`grantApproves`; a plain `treasury` grant never approves) and within that strategy's per-run ceiling
(`maxUsd`). An app that saves another strategy gets no swap until the owner, or the DAO, grants for it. The tick's
evidence start line names the app (`actor`). Limits: the app chooses when a pass runs, within those bounds, as the
schedule otherwise would.

### Cash floor (0.5.3, offline-tested)

A strategy may carry `cashFloor: { usd, assets }` (platform#23, Treasury ADR 4): whole USD of the named assets' public
and confidential balance that the agent's swaps may not take it under. It is bound like the rest of the strategy: the
grant's label carries the strategy's digest, and a DAO's grant proposal lists the floor among the strategy's terms.
`authorize` checks it on each planned swap, before its prerequisite shield and again before the swap, under the money
lock, so it covers the autopilot (scheduled and "Run now"), `executePlan` (the owner's session, `treasury-execute`
apps and machine credentials, and plans the removed steward stored) and proposals. A swap is refused with `cash_floor_exceeded` only
when it lowers cash and leaves it under the floor. A swap out of a named asset counts its full input, and one into a
named asset counts only its `minAmountOut`, both at the dispatch's fresh prices, as the per-run ceiling is valued. A
swap that adds cash is never refused, even while cash stays under the floor: the policy's caps make recovery a series
of small swaps. A named asset held without a fresh price refuses a swap that would lower cash
(`valuation_unavailable`). While a floor is set, a swap without a plan-bound valuation is refused for every purpose. A
proposal is also checked before its claim, its swaps taken in order at the observed book's prices, so a refusal that
check foresees leaves it approved. The send's own check uses prices read later, so a price move in between can still
refuse a swap after the claim; the claim is not undone.

Without `cashFloor` the strategy serializes exactly as before, so its digest, grant suffix and grants are unchanged;
leaving it out means no floor, never a default one. Offline: `test/authorize.test.ts` (the rule's edges),
`test/autopilot.test.ts` (scheduled tick and "Run now"), `test/treasury-proposals.test.ts` (a `treasury-execute`
plan, a steward plan, a proposal refused before its claim, a proposal that adds cash while under the floor),
`test/strategy.test.ts` (digests pinned from before the field, validation), `test/app-dao.test.ts` (the grant
proposal's terms). Each path test fails with the rule removed. A strategy saved while a swap's provider reads are in
flight refuses that swap (`strategy_changed`), as before the floor. Not deployed or mainnet-observed.

Limits:
- The floor bounds this agent's swaps only. The owner's own withdrawals and transfers (including a `pay` under a
  treasury grant), and money on other agents, can still take cash under it. Payout agents carry no floor.
- After a swap succeeds, the next swap's check reads balances that are assumed to reflect it, as the plan's
  feasibility check assumes. The provider's balance timing is not observed here.
- Valuations use floating point, like the per-run ceiling's individual values. A stablecoin floor is in USD, so a
  depeg moves it.
- Rebalance planning doesn't know the floor. If the targets call for cash under it, each autopilot run sends the swaps
  before the one that would cross it, then records that one refused (`cash_floor_exceeded`), every run, until the
  targets or the floor change.
- A server without this change drops `cashFloor` when it saves a strategy (the schema strips unknown fields). Apps
  check that the strategy `strategy/save` answers carries the floor.
- Rolling the server back to a version without this change drops a saved floor when the strategy is next loaded. The
  strategy's digest then changes, so the autopilot and `treasury-execute` plans stop until a new grant, and open
  proposals are invalidated. The owner's own plans run without the floor. Read from the code, not tested.
- A DAO's proposals are public, so a DAO's floor is public once its grant proposal is filed.

### Market hires: the payment key (0.5.6 and 0.5.7 released; 0.5.9 binding candidate)

A market agent hires listed agents on the NEAR AI Agent Market over x402 ([agent market](market.md)). The provider
enforces every send up to the agent's payment key: the market policy lets the agent `withdraw` only USDC and wNEAR,
only to chain `near`, only to that key's account, within its caps and budget, and `authorize` refuses a top-up beyond
what the hire still needs. The platform also checks the full approved USDC hire price against the current policy's
USDC per-transaction ceiling, including a partly or fully funded key: before any funding and again for each dispatch.
If the cap tightens after a top-up, the funding is retained and the payment refused. These are platform checks,
offline-tested in `test/market-hire.test.ts` and `test/authorize.test.ts`, not observed on mainnet. Daily/monthly caps and
USD budgets still count provider withdrawals, not the timing or sum of later payments from retained funds.
A DAO's approval deadline is checked after asynchronous signing and before every new claim; expiry stops paid-call
retries without resolving an already attempted payment. Earlier top-ups remain recorded even if the final payment is
refused. These boundaries are offline-tested in `test/market-deadline.test.ts` and `test/market-signing-race.test.ts`.
The 0.5.9 candidate writes a version 3 binding of the caller, requestId, brief, approved terms and payment key before
any top-up. The opening and USDC stages use fixed keys derived from it. Different terms with the same ID refuse
`request_conflict` even before x402 preparation; `market/status` sees a bound request as `funding` or
`funding_review`, not `not_found`. A submitted stage reserves the payment key across hires until a final destination
receipt proves the exact credit and a later final chain view includes it. A lost funding acceptance reply with no
provider correlation also answers `funding_review`; it cannot be polled or automatically replayed. Hosted release
refuses submitted funding without final proof, including legacy unbound top-ups, even with zero balances and an
explicit balance override. Proven landed funds retain the existing release balance choice and preserved binding.
Landed funds remain reserved to the original
request until its x402 payment is recorded or its binding is terminally closed; a new ID cannot spend them while an
expired approval waits for a fresh same-ID vote. Provider `SUCCESS` alone, a balance increase, or a
`FAILED`/`REFUNDED` status after submission is insufficient to release an unproven funding reservation. A locally
proven never-submitted or refused stage closes its binding's reservation. The provider may report a
delivered amount below the requested withdrawal; if verified USDC funding still leaves the key below the approved price, the hire
refuses `funding_shortfall` while retaining the credited funds and closing that request's reservation.
An expired DAO approval still permits status reads and recording receipt evidence without a new send, but continuing
an unsubmitted leg needs a fresh signed vote on the same terms and ID. Neither the binding nor these checks turn a
prior top-up into a payment or prove that a market task was delivered.
The last leg, the key's signed `ft_transfer` to the market, is not the provider's: its
payee, asset, amount and window are the platform's checks (the market's published payee, the exact terms approved,
`authorize`'s `market` purpose), and a payment's outcome is read from the chain, never from the market's answer. What
this exposes: whatever the key holds, at most one hire's price plus anything not charged and left on it, to whoever
can read the agent's settings file on its host, as the grant token beside it already is. A DAO's hire is paid only on
its signed approval, whose key the agent checks against its owner on the provider. Not yet observed through the
platform on mainnet; the market's x402 behaviour it relies on was observed from a local prototype (2026-11-09, docs/market.md).
A wNEAR top-up is capped at what opens the key's account (0.02 NEAR), whatever the policy's cap. A payment reads paid
only when the key's balance dropped by exactly its amount: anyone sending USDC to the payment key meanwhile turns a
paid hire `unknown`, which blocks the agent's sends until a person reviews it. That fails safe; it can stall the agent,
never pay twice.
The normal funding proof needs the provider's optional destination transaction hash and final NEAR receipt data. A
same-chain route may be hashless, and ordinary RPC can lose old receipt history before delayed reconciliation. Those
cases need reviewed recovery with independent archival evidence; there is no automatic recovery or proof inferred from
the provider's terminal status. Before a 0.5.9 executor starts on existing market state, stop executors and inspect
legacy unbound top-ups and retained key balances as described in [operations](operations.md). A submitted 0.5.6 through 0.5.8
top-up without a request binding causes `legacy_funding_review_required` on further hires and sends to that key,
even if the provider calls it terminal. Preserve the old key and records; new hires require a separately designed
and reviewed fresh-key recovery procedure after the old funds and any pending payment are accounted for. No
supported recovery route or automatic rotation exists yet. Rollout remains held for the stopped-writer audit and a
separately reviewed recovery design for affected keys.
Two gaps: a paid call whose answer is lost after the market took it loses the task id, so the deliverable can't be
fetched though the payment may settle (the payment itself still resolves from the chain); and the gateway can't tell
a DAO's setup's area when it forwards `agent_create`, so a role the area doesn't bind is refused by the agent, not the gateway.

### DAO owners through apps (offline- and stack-tested)

A DAO-owned agent reaches an app under a consent the DAO signs by its own vote: a passed proposal calling `v1.signer`,
found on chain by `findSignature`. Every text the DAO votes on is built by the platform (the consent and setup texts,
`proposalText`, and the provider's owner intents for creation, the grant, its revocation, a policy edit, freeze and
unfreeze). The app gets the proposal a member files, never a text or intent to sign. A policy edit through an app may change any field. An off-chain edit
(`destinations`, `withdrawals`, `budget`) is a readable NEP-413 message. An on-chain edit carries the policy encrypted:
the DAO relies on the provider's preview of it, as a wallet owner does, and nothing here checks the encrypted bytes
against the policy shown (the user's decision, 2026-11-05). Its public proposal names the changed fields only, never
values; the app gets both policies from `owner/prepare` to show members (offline-tested, `test/app-dao.test.ts`,
`test/proposals.test.ts`).

What holds, offline-tested in `test/app-dao.test.ts`, where each planted fault fails a test:
- A request stores or relays only a signature that verifies against the DAO's derived key over its exact hash. The
  platform picked the nonce, and the signature must be found before the request's `votingUntil`.
- A DAO's consent carries only `read`, `treasury` and, as its opt-in, `treasury-execute`. Swaps without a vote each
  time (autopilot, and the app's plans with `treasury-execute`) run only under the grant the DAO voted for the saved
  strategy, checked under the lock before the claim, as for a wallet owner. The grant's proposal says it authorizes
  them.
- On every call, the platform re-reads that the agent is configured with that DAO and that its server reports the DAO's
  derived account. A proposal vote is relayed once, and only while the consent it was filed under is live.
- A DAO's setup consent prepares only the agent's creation, with the derived account as owner.

Stack-tested in `test/e2e/app-access.spec.mjs` with simulated DAO votes: setup, creation, consent, the grant, a
proposal approved and executed once.

Limits:
- The approval is the platform's check, as for a wallet owner's proposals.
- Only a DAO whose vote passes within the provider intent's window completes creation, the grant, its revocation, a
  policy edit, freeze or unfreeze: 600 s for wallet requests (creation, freeze, unfreeze, on-chain policy edits) and
  about 290 s for consent messages (the grant, a revocation, off-chain policy edits), per the provider's docs
  (owner-signing, signing-standards, read 2026-11-05). No request field lengthens it (sdk-typescript 0.7.3
  `generateIntent`). The delegate action a DAO signs for a wallet request stays valid on chain for 6,000 blocks
  (`src/dao-owner.ts`), so the provider's expiry is the tighter limit. A slower DAO can still approve each swap as a
  Treasury proposal, which has no provider window, but can't turn on autopilot or freeze its agent by vote (#20); its
  own stop (below) neither freezes the agent nor revokes the grant. Nor can it grant its market agent, so a DAO-owned
  market agent can't hire unless the DAO's vote on the `market` grant passes in about 290 s; each hire's own vote has
  no provider window.
- The platform authorizes the app, not a member. The app gates its own members with the SDK's `accessOf` and `mayCall`.
- **The DAO's own stop** (`/confirm/dao/stop/<dao>/<agent>`, no app involved) ends everything given before it first
  applies, once the DAO's vote over the exact text is found and the page is opened: every app consent for the agent ID
  is revoked, every consent request filed by then is never stored, whatever its vote, and the agent's autopilot is
  turned off. Filing a stop early gains an app nothing: the cutoff is when the stop applies. A passed stop is honoured
  whenever its page is next opened, even after its window, and is kept until then. The exception is a stop whose page is
  opened after its window while its vote hasn't passed yet, or before the indexer shows it: that stop lapses and a new
  one is filed, and a later signature over the old hash is ignored. The page's open limit is per address, so no one
  can keep it closed to members. What it doesn't do:
  - It can't revoke the provider grant, which would need a provider intent valid for minutes. A consent the DAO gives
    after the stop applied stays live, and under it an app can turn autopilot on again at once.
  - It doesn't interrupt a tick already running, or an app's call already forwarded (an `executePlan`, say): their
    swaps still pass the guarded send path.
  - Owner actions already waiting for the DAO's vote (a grant, a freeze) still take effect if that vote passes.
- **A wallet owner's own stop** (`/confirm/wallet/stop`, [app access](app-access.md)) does the same for agents a
  wallet owns, signed by the owner's full-access key with no app, and has the DAO stop's limits above. From 0.5.5 the
  same page also offers the freeze, the one control that stops every send: a stop text ending `"freeze":true` has the
  platform prepare each named agent's `agent_freeze` through that agent's own `owner/prepare`, the owner's wallet signs
  the provider's intent on the page, and the platform checks that signature against the held intent before forwarding it
  to the agent's `owner/submit`, where the provider verifies it. Only the signed stop authorizes it, and the page hands
  out only a NEP-366 intent calling `freeze_wallet` (or a NEP-413 text) for the owner's account. The freeze intent is
  signable for 600 s (Limits above); unfreezing isn't offered there. Offline- and browser-tested with a stand-in
  wallet; no freeze is recorded on mainnet ([app access](app-access.md)).
  It ends the consents stored by its cutoff, and after it a consent or setup for those agents is stored only if the
  platform issued its NEP-413 nonce after the cutoff ([app access](app-access.md)), so one the owner signed before the
  stop and an app sends later is refused. Apps that pick their own nonces keep working until the owner's first stop;
  then they must ask for one. Offline- and browser-tested; not deployed.
  - A slow DAO's stop waits its voting period, and nothing changes until someone opens the page after the vote:
    autopilot and the consents it will end stay live until then.
- A DAO's Treasury grant proposal says what it authorizes without a vote each time (autopilot, and plans of apps the DAO
  consented to with `treasury-execute`) and names the strategy it binds: its digest suffix and its terms (targets, cost
  cap, the autopilot's per-run ceiling, and its cash floor when it has one). It is a provider owner intent, so no platform page recomputes its hash: members
  compare it with the `v1.signer` call's `payload_v2`, as the description says.
- **What a DAO's votes make public.** Sputnik proposals are public and permanent, and so is every check page their
  descriptions link to:
  - the consent and setup terms: app deployment, Organization, agent and scopes
  - each proposal vote's swaps, with their amounts and floors
  - the strategy a Treasury grant binds: targets, cost cap, minimum leg, the autopilot's per-run ceiling and any cash floor
  - each stop
  An Organization that wants its strategy or swaps private uses a wallet owner, whose signatures stay off chain.
- The derived key can't be removed, so the wallet's key-removal revocation has no DAO counterpart, and the operator's
  `check-keys` sweep leaves DAO consents alone.
- The app holds the transactions a member files, so it could file its own `add_proposal` with this description but
  another hash in the `v1.signer` call. The platform ignores any hash but its own. The members' check is the platform's
  page that each description links to (`/confirm/dao/<hash>`, the exact text and its hash recomputed): they compare that
  hash with the call's `payload_v2`. Nothing enforces that a member opens it. `proposalAndVote` binds the vote to the
  filed kind (`act_proposal` passes it).
- The check page covers the platform's own texts (setup, consent, proposal votes). For a provider owner intent
  (creation, grant, freeze), the agent builds the description from the provider's preview, as on the owner session, and
  no page recomputes its hash.
- **Funding:** found on platform staging (2026-11-04), a DAO's consent couldn't reach `deposit`, which was in `payout`
  only. From 0.5.1 the `treasury` scope reaches it: offline-tested, and mainnet-observed on staging on 2026-11-05
  ([mainnet log](mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc)), the DAO funding its agent by its own vote. `deposit` answers an address that only credits the
  agent's own balance.
- Mainnet-observed on platform staging, 2026-11-04 ([mainnet log](mainnet-log.md#a-dao-owned-treasury-agent-through-an-app-on-platform-staging-2026-11-04-utc)):
  setup, creation, consent, the strategy-bound grant, autopilot on and the DAO's own stop; 2026-11-05
  ([mainnet log](mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc)): funding, and an app's proposal approved by DAO vote and executed under the DAO's grant. Not
  observed: freeze, unfreeze. Not in production.

### A wallet owner's vote on a held payout through an app (offline- and browser-tested)

The vote's signed text, OutLayer's `approve:{approval_id}:{wallet_pubkey}:{request_hash}`, names no payee or amount,
so the owner's wallet can't show what an approve releases. The agent proves the terms against the provider's request
hash before preparing and again under the money lock before submitting (`checkPaymentApproval`), but until #48 the
owner read them only where the app showed `payment.terms`. Now the prepared vote carries a link to the platform's
confirm page, which shows those proven terms, taken from the agent's answer and never from the app's request, and
submits through the agent's own `owner/submit` ([app access](app-access.md)). The page is optional: the app also gets
the vote's text, unchanged, and may keep the owner off the page. It helps an owner the app sends there; it doesn't bind
a dishonest app, which can show other terms in its own page and have the owner sign the vote there. Neither the owner
nor the operator can require the page.

Tested in `test/app-access.test.ts` (the link, terms bound to the payout and verdict asked about, no opening step, one
submission per link) and `test/browser/approval-confirm.cjs` (with a stand-in wallet, the page shows the terms and the
wallet signs exactly the vote's text, once). Not stack-tested, not deployed, and signing with a real wallet is untested.

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
DAO machine credentials stay refused (DAO app consents are a separate route, above); there is no OAuth/MCP interface, or distributed revocation/fencing. Local
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

## A payee's view of their own terms (offline-tested)

From platform#51, a payee reads their own terms in the agent's policy from the platform host under the owner's signed
payee disclosure, with no app relaying them ([app access](app-access.md)). It is read-only: it moves nothing, adds no
rule to `authorize.ts` and touches no send path; the agent's `payeeTerms` read is reachable only by the gateway. What
it does not establish:
- **Independent verification.** The answer is the platform's account of the provider's policy view, read by the agent
  with the platform's partner key. The policy is stored encrypted, the on-chain `agent_policy_hash` isn't a function of
  it, and both the API's `policy_hash` and the mandate digest need the whole policy to recompute (see "Signed policy
  binding" above). The answer is unsigned.
- **Enforcement.** That the provider enforces the terms shown is as unverified as for any policy (status above).
- **Privacy of the rest.** The answer leaves out the provider's `policy_hash`, and the mandate digest unless the owner
  opts in within the signed disclosure (`"discloseDigest":true`). Either commits to the whole policy, so a payee who can
  guess every other field (an agent paying only them under a known template) could confirm the guess, including caps,
  budgets and other payees. With the opt-in that leak is the owner's accepted choice; without it the revision shows that
  the policy changed, not what.
- **DAO owners and revocation.** Wallet owners only; nothing is stored, so a disclosure ends only at its expiry, when
  the agent is replaced, or while the owner's signing key is absent or not full-access on chain.


### Hosted-agent release (0.5.6, offline- and stack-tested)

The owner's provider archive is the authority to retire hosting; a separate explicit call under owner consent releases
the slot. The executor rechecks archived/frozen provider evidence and every unresolved, held and open owner action under
its locks, reads balances and durably blocks dispatch before registry changes. Read failures refuse, including with
`allowBalance: true`. This balance override also covers a market payment key's native NEAR and USDC; unsolicited other
assets on the key are not enumerated. All settings, records and keys remain recoverable. Fresh owner setup/consent is
required for restoration, and old consents stay ended. Lifecycle and money locks coordinate one host, not distributed
fencing. Provider archive/restore refusal semantics remain per pinned docs (`ce381df`), with no mainnet observation;
DAO release and incomplete-transition rollback are not covered. See [agent release](agent-release.md) for tests and limits.

## Treasury limit orders (SDK 0.5.8; platform rollout pending)

The owner must sign a policy revision enabling `limit_order` and a deviation ceiling, then sign each immutable
order's exact terms. A dedicated `treasury-orders` app consent and live Treasury grant are also required by this
platform. These application bindings do not prove a bypassed holder of the grant cannot place another order within
the provider's policy. Provider enforcement of price deviation, asset caps, USD budget and action permission is per
[pinned Agent API documentation](https://github.com/NEAR-Intents-Agent-API/skills/blob/0b81bba6fca6356a2db81d0ede08e9cb928d08e1/near-intents-agent-api/references/limit-orders.md),
not independently established on the running service.

The local output-asset authorization applies to both sides: a sell acquires quote, a buy acquires base. Orders are
refused while a Treasury cash floor is configured, because a resting order cannot be valued as one settled swap.
Placement rechecks the policy, strategy, grant, signed gross spend and an unwarned dry preview under the money lock;
one journal claim precedes one provider call. A lost answer stays unresolved. Provider placement `SUCCESS` identifies
a funded order, not a filled trade. Complete means closed fill and final completed payouts from a live order read;
partial fills, pending cancellation, failed payout and unreadable finality remain reviewable. A cancel is claimed once,
then only read after an ambiguous reply. Hosted-agent release refuses tracked or listed orders with open or unreadable
finality even with a balance override; a lagging provider list cannot prove the absence of an external order.
These paths have offline tests, but no live placement, fill, cancellation or payout observation.
The production provider route was absent in the 2026-11-10 read-only check. See [limit orders](limit-orders.md).


DAO access filing recovery (2026-11-12 source review): setup and consent filings choose a new
nonce on each call (`src/gateway/app-dao.ts`, `DaoRequests.file`). A lost filing reply retried with
identical text can produce another request/hash; saved-text reuse is not same-request recovery.
Known IDs must be polled. This does not establish duplicate payout execution. DAO payout local
acceptance does not cover SIGKILL recovery, provider-response loss, hosted member-wallet filing,
actual quorum or mainnet settlement; see docs/app-access.md.


### Final receipt completeness (0.5.9 candidate)

The Market funding verifier does not discard unmatched receipt outcomes. If a final transaction omits receipt
bodies, it reads at most 16 exact IDs already present in that transaction's outcomes and requires matching IDs
and executors before checking credits. Missing, conflicting or unavailable bodies still refuse proof
(`test/market-funding-proof.test.ts`, offline-tested). Two retained historical payout transactions replayed with
exact separately captured receipt bodies on 2026-11-12; no Market-route deployment or new withdrawal is established.
The deployed Market top-up route, external authority, retained balances and legacy-key recovery remain unverified;
SDK package publication does not authorize a Market executor rollout or clear an affected key.


### Bounded Market creation candidate

An explicit wallet-only hosted Market creation profile builds the proposed initial test caps from the
original durable reservation and payment-key settings (offline-tested in
`test/market-creation-profile.test.ts`; see `docs/market-funding-proof.md`). It is not a deployed-provider
observation or permanent restriction on later owner policy edits. Older servers can omit an unknown
profile input; verify the exact prepared and applied policy before any grant or funding.

### Incoming confidential credit coverage

Recipient execution history does not establish complete incoming confidential funding. Receipt-backed incoming-credit records can account for external funding without modifying execution journals. Provider settlement status is preferred; an explicit operator attestation has weaker trust and remains labelled as such. Missing history and a balance shortfall are distinct, but either still holds Treasury proposals until resolved. Automatic incoming-credit discovery and independent custody proof remain unestablished. See [incoming credits](incoming-credits.md) for the record format, duplicate/overlap refusal and stopped-executor procedure; this capability is offline-tested, not a mainnet correction observation.
