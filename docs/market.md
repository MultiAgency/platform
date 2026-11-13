# Agencies on the NEAR AI Agent Market

**Status: the market base shipped in 0.5.6 on 2026-11-10; #62's approval-deadline and requestId checks shipped in
0.5.7 on 2026-11-11. The pre-funding binding below shipped in SDK 0.5.9 on 2026-11-12. Its pre-reconciliation head
`ae60790` was tested offline, in the browser, and in narrow stack E2E on 2026-11-11. The full E2E suite with the Treasury skill fixture was not run, and no hire
has been observed through the platform on mainnet. Rollout is held pending the audit in [Rollback](#rollback).** Built,
against a simulated market and chain (`test/e2e/market.mjs`) and a stand-in Agent API: the quote check, client,
payment key and chain resolution (`src/market/`, `test/market.test.ts`); the `market` area (app setup only), the key
written at reservation, the market role and policy, creation bound to them (`test/market-agent.test.ts`); the `x402`
operation through `dispatch` → `send`, the `market` purpose in `authorize` (`test/authorize.test.ts`), resolution in
reconciliation, the hire flow and the `market` app scope (`src/market/hire.ts`, `test/market-hire.test.ts`); the DAO
path: `market` in DAO consents and setup, `/apps/v1/dao-hires` and `market/approve` (`test/app-dao.test.ts`). The simulated market is wired into the local stack (`test/e2e/market.spec.mjs`). A separate offline worker test exercises the market directory, a self-hosted worker's token-scoped assignment, signed webhook, polling fallback, submission and x402 payment after delivery (`test/e2e/market-worker.spec.mjs`). The app-server skill supplies typed guidance. Gaps are in
[enforcement](enforcement.md#market-hires-the-payment-key-056-057-and-the-059-binding-released). Decisions
recorded with the user on 2026-11-09: agencies take both sides of the market (they hire agents as clients and list
agents as workers); hires are paid over A2A + x402; the upstream asks below are pursued; the app is Covenant
(`MultiAgency/demo`) over `/apps/v1`; a `market` purpose joins `authorize` (payee the market's published `payTo`, asset
USDC, amount the approved quote); a DAO may sign a consent with `market` scope, and pays each hire only after a vote
on its exact terms (no DAO counterpart of `treasury-execute`). The top-up rule in [Authorization](#authorization) was approved
the same day.

Sources read on 2026-11-09: the market's docs (`docs.market.near.ai/llms-full.txt`, `skill.md`), its OpenAPI 2.0.0
(`market.near.ai/openapi.json`) and `/.well-known/x402`; the Agent API SDK at `NEAR-Intents-Agent-API/sdk-typescript`
`bddab8b` (2026-11-06); the NEAR Intents contracts at `near/intents` `32cd1f9` (2026-11-04). Market behaviour below is
*per the market's docs* (and its x402-caller skill 0.2.0, `market.near.ai/skill/x402-caller/SKILL.md`) unless marked
otherwise; none of it has been observed by this project.

The worker simulator was checked against the market's OpenAPI 2.0.0 and self-hosted-agent guide on 2026-11-11.
Its local directory and worker routes exercise those documented shapes; they are not a deployed-market observation.

**2026-11-10 dependency follow-up:** 0.5.6 now pins Agent API SDK 0.8.2, reviewed at
`416597b0c63a426b225b98b6d175c03bfb6a7947`, with official skills at `0b81bba6`. Its signed 1Click quote inputs are for
EVM/Solana Intents signatures, not NEP-366 delegate signing: they do not replace this market payment key. The market's
x402-caller skill remains 0.2.0. The documented validity rule still differs from the prototype observation below;
this dependency upgrade does not resolve that discrepancy or establish deployed behaviour. See
[provider SDK upgrade](provider-sdk-082.md).

## The market, as documented

- **Jobs.** `instant` (the buyer picks an agent), `standard` (agents bid, the buyer awards) or `competition` (a prize
  pool split by a judge). An award creates an **assignment** (one job, one agent, one held payment), then
  `in_progress` → `submitted` → `accepted` | `disputed` → `dispute_resolved` | `cancelled`. Work left untouched is
  accepted when the acceptance window ends (3 to 7 days). A dispute costs 5% of the price; an automated resolver rules
  about every 12 hours, and a person reviews on request.
- **Money.** Prepaid account balances in USD (Stripe) or USDC. The Terms call held funds "not escrow". USDC wallets are
  custodial: the OpenAPI names OutLayer as the wallet rail, and crypto ledger rows carry a NEAR Intents `intent_hash`.
  The platform fee is 5% of the builder's price. Builders withdraw USDC to an address they enter, with no identity check.
- **Buying.** Two routes:
  - *Account + MCP.* `/mcp` returns approval links; `/mcp/pro` spends in the call (`marketplace__create_job`,
    `award_bid`, `accept_result`). "Nothing on the server caps how often `marketplace__create_job` runs."
  - *A2A + x402 from a bare wallet.* Every listed agent is an A2A server at `https://<handle>.market.near.ai/a2a/v1`.
    `SendMessage` unpaid answers `402` with `accepts[]` (`scheme: "exact"`, `network: "near:mainnet"`, USDC asset,
    `payTo` the market's treasury, `maxTimeoutSeconds`). The caller signs one NEP-366 delegate action, `ft_transfer`
    of exactly `amount` to `payTo`, and repeats the call with `X-PAYMENT`. The payment is held and settled only when the
    agent delivers; `TASK_STATE_REJECTED`, `FAILED` and `CANCELED` charge nothing and the authorization expires. An
    x402 hire is accepted at once on delivery: no rework, no dispute. `GetTask` is free to poll. The `402` quotes the
    agent's default plan only (no bids). `maxTimeoutSeconds` is the agent's window plus 10 minutes, and the payment
    stay valid at least the agent's window: one that expires sooner is refused ("expires before the job's SLA
    window"). Observed on mainnet (2026-11-09), it may not be valid longer than `maxTimeoutSeconds` from the market's
    own view of the chain either: a payment valid exactly that long from the latest block was refused with
    `invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout`, though the skill says never to
    shorten it. The platform signs 60 blocks under (`paymentExpiry`). A `502` means the facilitator was unreachable: resend the same header, never
    re-sign. A replayed header is refused.
- **Working.** An agent's `aat_` token bids, starts, reports progress and submits deliverables; it can't move money or
  open disputes. Webhooks (`hire.created`, `hire.accepted`, `hire.changes_requested`, `hire.disputed`, …) are signed
  with HMAC-SHA256 and delivered at least once, unordered; the docs say to poll as well.
- **Payee.** `GET https://market.near.ai/.well-known/x402` publishes the market's payee per network. On 2026-11-09 it
  answered one row: `near:mainnet`, asset `17208628…6133a1` (native USDC on NEAR), `payTo` `ea667f5f…f539fc`.

## Why the platform

The market has jobs, held payments and disputes, and no buyer-side policy: the buyer's MCP client prompt is its only
spending gate. The platform has the owner-signed policy, DAO votes, the one send site and the journal. Hiring through
the platform gives each hire a write-ahead record, unknown outcomes that block, and a DAO vote where the owner is a
DAO. The provider's signed caps and budget limit funding withdrawals to the payment key. The platform additionally
checks each full hire price against the policy's USDC per-transaction ceiling, including funds retained on the key.
The locally signed payment remains outside provider enforcement, as detailed below.

## Agency as client: hiring over x402

### Why a payment key, for now

x402 needs the payer to sign a NEP-366 delegate action. The Agent API can't: `native/near/call` sends the transaction
itself, and `native/*/sign-intent` signs only NEAR Intents `transfer` payloads, which the market doesn't accept. Until
one of the [upstream asks](#upstream-asks) lands, the platform signs with its own key. The signer sits behind one
port (`sign(delegate terms) → SignedDelegateAction`): the payment key now, the Agent API's delegate signing if ask 1
lands. Quoting, the payee check, the journal, approval and resolution don't change with it.

Each market agent gets one **payment key**: an Ed25519 key whose implicit NEAR account holds the current hire's USDC,
any funds retained from earlier not-charged hires, and a little NEAR for its account. The platform writes it into the agent's settings file at reservation
(`MARKET_PAYMENT_KEY`, mode 0600), before the agent exists, so the policy the agent is created with can name its
account; normal hire routes never replace it or return it, and it signs exactly one shape: `ft_transfer` on the market's published USDC
contract to the market's published `payTo`, of the approved amount. The provider still enforces everything up to that
key: the agent's policy lets it `withdraw` only USDC and wNEAR, only to chain `near`, only to the payment key's account,
within per-transaction limits and a USD budget. What the provider can't enforce is the last leg; the payee check there
is the platform's. That is a weaker guarantee than a provider-enforced send and goes into `docs/enforcement.md` with the
code.

### Flow

1. **Quote.** The app asks the agent for a quote: `market/quote { handle, brief }`. The executor sends `SendMessage`
   unpaid, takes the `near:mainnet` row of the `402`, and refuses unless `scheme` is `exact`, `asset` and `payTo` equal
   the row `/.well-known/x402` publishes, and the handle matches the market's handle rule (so the call, and the
   payment, can't be pointed at another host). The answer carries the **hire terms**: handle, brief hash, amount,
   `payTo`, asset and `maxTimeoutSeconds`.
2. **Approve.** A wallet owner's consent with `market` scope pays within the signed policy with no further signature,
   as `payout` does with `owner_approval: false`. A DAO approves each hire's exact terms by vote first, as it approves
   Treasury proposals (`proposalText`): the hire is filed as a durable proposal and paid only once the vote passes.
   Since 0.5.9, a repeated filing returns no transaction by default. If its first answer was lost, inspect
   the DAO for prior submission before explicitly asking for the original proposal with
   `recoverProposal: "dao-checked"`; an ended original consent or changed signer blocks recovery.
   A vote takes days and the agent's price can change meanwhile: the hire re-quotes before paying and refuses unless
   the new `402` row equals the approved terms. The signed `validUntil` is checked before each new submission,
   after asynchronous preflight and signing, including top-ups and paid-call retries.
3. **Hire.** `market/hire { requestId, brief, approved }` sends once per caller and `requestId`, under the money
   lock, through `dispatch`, purpose `market`. Since 0.5.9, after the quote and policy checks, it first
   writes a version 3 journal binding of the caller, ID, brief, approved terms and payment key. A retry with different
   terms now refuses `request_conflict` before an x402 payment exists. The two money legs are:
   - *Top-up:* a provider `withdraw` of the shortfall (the quote less what the payment key already holds) and, the
     first time, wNEAR to open its account. The opening and USDC stages have fixed keys derived from the hire binding,
     so a retry follows the recorded withdrawal. A submitted top-up reserves the payment key across all hires until
     its exact destination receipt is verified final and a later final chain view includes that receipt. The landed
     funds then remain reserved to that request until its x402 payment is recorded or its binding is terminally
     closed. Another requestId cannot consume them while the original waits for a fresh vote. Provider `SUCCESS`
     alone does not prove the key was credited. Missing, hashless, failed or refunded provider evidence cannot
     release a submitted stage's reservation automatically. A locally proven never-submitted or refused stage closes
     its binding's reservation; a provider `FAILED` or `REFUNDED` after submission does not.
   - *Payment:* a new `Action` method `x402`, sent from `send` like every other submission, so
     `test/send-path.test.ts` still holds. The payment terms are recorded, then the delegate action is signed and
     `SendMessage` is repeated with `X-PAYMENT`. The task id is recorded the moment it is known: it is the only way back
     to a paid result.
4. **Follow.** `market/status { requestId }` answers `funding` for a bound hire with a pending top-up,
   `funding_review` when a provider outcome is terminal or unknown without final landing proof, an attempted
   withdrawal lost its acceptance reply and has no provider correlation to poll, or landed USDC
   still awaits the hire's payment, `refused`, `paid` (the x402 transfer observed on chain,
   regardless of task state), `not_charged`, `unknown`, or `not_found` only when no binding or payment is recorded.
   It also polls `GetTask` while the task moves. Funding can remain on the key when a later leg is refused or DAO
   approval expires; expiry does not undo withdrawals. A status call can append receipt evidence after expiry without
   submitting money.
   Continuing an unsubmitted leg needs a fresh signed DAO vote with the same terms and requestId; other IDs cannot
   spend its landed funds while it waits. Changed terms conflict even when only the binding or a top-up exists. An
   attempted x402 payment remains poll-only.
   If verified USDC funding still leaves the key below the approved hire price, the hire refuses
   `funding_shortfall` and retains the credited funds. The terminal refusal releases that request's reservation;
   inspect the key balance and recorded funding before any new request or vote.

### When a payment is resolved

A signed delegate action can be relayed by whoever holds it until its `max_block_height`, whatever the task does. So
the money's outcome is read from the chain only, never from the task's state; an `x402` operation is unresolved, and
blocks the agent's other sends, until one of:
- **Paid:** at one final block, the payment key's access-key nonce has reached the delegate's nonce and its balance is
  exactly the balance at signing less the amount. The key signs nothing else and no top-up runs while a payment is
  unresolved, so only this delegate action can have done both.
- **Not charged:** the chain's final block height is past the delegate's `max_block_height` and the payment key's
  access-key nonce is below the delegate's nonce (it was never relayed, and now can't be).

Anything else stays unknown, as every operation does. The task's state is the deliverable's, recorded beside it: a
charge with no deliverable is a dispute with the market, not an unknown payment. An undelivered hire blocks its agent
until its window ends, and the window is the agent's own plus 10 minutes, which can be days. So market hiring is its
own hosted area (`market`), one agent per owner, never shared with payouts or Treasury, and the agent refuses a quote
whose window exceeds a configured maximum (`window_too_long`). One key also means one outstanding authorization at a
time: a delegate action with a later nonce, relayed first, would invalidate an earlier one.

### Authorization

A `market` purpose and grant label (`market`), with facts read under the lock: the published payee row, the payment
key's account and balances, the approved terms and, for a DAO, the passed vote.
- *Top-up:* `withdraw`, chain `near`, no memo, asset USDC or wNEAR, recipient the payment key's account, which must be
  an agreed withdrawal destination of the policy; USDC no more than the approved amount less what the key holds.
- *Payment:* `x402` to the published `payTo`, in the published asset, of exactly the approved amount, for the approved
  handle and brief hash; for a DAO, only with a passed vote on those terms.
- Every case: the policy in force and a live `market` grant, as for any purpose. The full approved USDC price must
  fit the policy's USDC per-transaction ceiling, even if the key already holds part or all of the price. The hire
  preflight refuses before opening or funding the key; `authorize` rechecks for every top-up and the payment before
  signing. If the ceiling tightens after a completed top-up, that funding stays recorded and retained, but the payment
  is refused. No automatic replacement is sent. Offline regressions in `test/market-hire.test.ts` and
  `test/authorize.test.ts` cover these cases and an exact-ceiling hire.

Daily/monthly caps and USD budgets account for provider withdrawals when they occur, not later payments from retained
key funds. This change does not add payment-time cumulative accounting or make the last leg provider-enforced.
For a DAO, the deadline is checked after all asynchronous reads and signing, immediately before each submission claim.
If approval expires after a paid call was attempted, further 502 retries stop while its recorded outcome stays unknown
until chain evidence resolves it. Offline regressions cover expiry during ownership, dispatch reads, finality,
signing and retry waits (`test/market-deadline.test.ts`), and lost lock/shutdown/release during signing
(`test/market-signing-race.test.ts`). No platform mainnet hire observation is claimed.

### State

No new state directory. The payment key is in the agent's settings file, preserved with it (`docs/operations.md`).
0.5.9 adds version 3 binding and verified-landing lines to the agent's `.ops/` journal before and
beside version 2 money operations. The binding is durable before funding; the landing line identifies the exact
submitted stage, provider correlation, destination transaction and final receipt height. The x402 operation records
its terms, delegate nonce, `max_block_height` and key balance at signing. The market's task id and observed task
states are kept in separate evidence beside the journal. Executor only; an approve-only copy answers `market/status`
from the executor.
The original proposal bond for a DAO hire is retained in a private `.app-access/dao-requests/<hash>.proposal-bond`
sidecar, written before the request JSON. Preserve it with `.app-access` when backing up state. The released 0.5.7
gateway ignores this sidecar and can read the unchanged strict request record until a version 3 money journal line is
written.
The normal proof path uses the provider's optional destination transaction hash and final NEAR RPC receipts. Some
same-chain routes have no public destination hash, and regular RPC may no longer serve a delayed receipt. Those cases
remain reserved until reviewed recovery with independent archival evidence; there is no automatic recovery or
inference from provider `SUCCESS`, `FAILED`, `REFUNDED` or the payment-key balance alone.

### Rollback

Downgrading a host below 0.5.6 is unsupported once it has written a market reservation, a consent carrying `market`,
a DAO market setup or hire request, or an `x402` journal record. These are not isolated to a market executor:
0.5.5 rejects `area: "market"` in the shared `.hosted/apps.json`, so one reservation prevents the entire gateway from
starting, including Treasury and Payables. Shared consent/request readers also reject the new scope, area or hire kind.
The mixed-host regression in `test/market-rollback.test.ts` uses the actual 0.5.5 registry reader and reproduces the
startup refusal before any hire; it verifies all reservations and settings remain intact and the current reader can
resume all three areas.

Before upgrading, stop executors and back up every state directory and instance settings file listed in
[operations](operations.md). If a release fails after writing 0.5.6 market records, keep executors stopped and
recover on a compatible 0.5.6-or-later build. There is no tested downgrade conversion. Do not delete market entries,
strip scopes or request fields, or restore older shared directories: that can discard identity, revocation or payment
evidence. A downgrade requires a separate compatibility review and a tested state-preserving procedure.

The 0.5.9 binding adds a second rollback boundary: after the first version 3 binding or landing line, a
0.5.6, 0.5.7 or 0.5.8 executor rejects that agent's entire operation journal. Before starting the new executor, stop every
executor and inspect legacy market top-ups written by 0.5.6 through 0.5.8 without a request binding. Reconcile their provider
correlations, on-chain credits, payment-key balances and any outstanding x402 payment; do not treat the new binding
as retroactive proof of those withdrawals. The new executor refuses further hires and sends to a payment key with
a submitted legacy unbound top-up (`legacy_funding_review_required`), even if its provider status is terminal. Preserve
the old journal, settings and key. New hires would require a separately designed and reviewed procedure that
provisions an isolated fresh key after the old funds and any pending payment are accounted for; no supported
fresh-key recovery route, automatic rotation or clearance exists yet. Once version 3
is written, recover with the exact reviewed binding-capable reader and retain its source commit and package
provenance. The released 0.5.8 SDK and platform source have no version 3 binding reader; 0.5.9 (tag `sdk-v0.5.9`, commit `252cba1`) has one:
retain that exact source and package provenance. A downgrade needs a separate state-preserving compatibility procedure.
Rollout remains held until the stopped-writer audit establishes which existing market keys have submitted 0.5.6 through
0.5.8 unbound top-ups and pending x402 payments, and confirms that the provider route supplies a destination
transaction with a final receipt the executor can verify. Any affected key needs a separate reviewed recovery design.

An older executor additionally refuses a journal holding `x402`, and an SDK before 0.5.6 rejects market operations in
`activity`, `unresolved` and other journal reads (`OPERATION_METHODS`) and owner outputs naming `area: "market"`.
That client limitation does not establish host rollback compatibility.

## Agency as worker

Mostly the app's: the agency lists its agent on the market from its owner's market account, the app holds the `aat_`
token, receives `hire.*` webhooks (and polls `GET /v1/agents/me/assignments`), does the work and submits deliverables.

The offline stack (`pnpm test:e2e:stack --app covenant --market --no-browser`) now lists `writer`, `refuser` and
`worker` at its simulated `/v1/agents` directory. `worker` exposes token-scoped assignments, start and submit routes;
the stack keeps its `aat_` token and signing secret in a mode-0600 `market-worker-credentials.json`, named by path only
in `state.json`. `--market-webhook-url http://127.0.0.1:<port>/webhook` sends signed `hire.created` events to a local
receiver; the simulator refuses non-loopback URLs. A 2xx webhook receipt marks start, and a repeated delivery uses the
same delivery ID so a worker can deduplicate it (`marketRedeliver` is the stack's file control). Without a webhook,
polling and explicit start still work.
`test/e2e/market-worker.spec.mjs` runs a buyer Organization's hosted market agent against a separate simulated worker
and a polling-only worker. It checks assignment ownership, exact webhook HMAC, duplicate delivery, and chain payment
only after each worker submits; an expired signed payment stays not charged even if the worker submits late. It does not
exercise a deployed worker, market earnings withdrawal, or earnings return
to the second agency's agent.

Earnings land in the market account's USDC balance, which belongs to the person who signed in to the market, not to
the agency. The platform's part is the way back: `deposit` (under `payout` or `treasury`) gives a one-time address
crediting the agency's agent, which the market withdrawal pays into. Whether a market withdrawal can pay a 1Click
deposit address was reported successful in the user-run local-prototype spike S2 after owner registration on USDC; this has not been observed through the platform. The app records each accepted assignment beside the
deposit it was withdrawn to, so the agency can reconcile earnings; the market's custody of that balance until then is a
limit to state, not one the platform removes.

Two agencies on the platform close the loop: one hires the other's listed agent over x402; the other's earnings return
to its agent by `deposit`.

## Upstream asks

Drafted for review before posting (`coordination/market-upstream-drafts.md`), none posted:
1. **Agent API:** sign a NEP-366 delegate action for `ft_transfer` only, to a policy destination, with the policy's
   assets, limits and budget applied. With it the agent pays x402 from its own NEAR account and the payment key retires.
2. **Agent API:** apply `assets`, `limits` and `budget` to `native/*/sign-intent` transfers, which today skip them.
3. **Market:** an x402 scheme settled by a signed NEAR Intents `transfer` (the market's wallets already settle on
   NEAR Intents), so an agent pays from its Intents balance under its policy with no NEAR account at all.
4. **Market:** buyer webhooks and a buyer token with a spend cap, so an account-balance client isn't gated by an MCP
   prompt alone.

## Spikes

Live runs are the user's to make, with small amounts.
- **S1:** one x402 hire end to end: the `402` row against `/.well-known/x402`, when the delegate is relayed (the docs
  say on delivery; the simulator relays at delivery), whether `configuration.returnImmediately` on both calls is
  accepted (the client doesn't send it until observed), and, for a rejected task, the payment key's nonce unchanged past `max_block_height`.
  - *First run, 2026-11-09 (UTC), mainnet, `web-research`, from the local prototype in `~/agencies/market` with the
    Agent API's staging deployment (`api.demo.agentsonintents.com`), not from the platform.* The `402` row matched
    `/.well-known/x402` (`exact`, `near:mainnet`, `maxTimeoutSeconds` 780: the agent's 180 s plus 10 minutes). The
    top-up `withdraw` answered `UNCERTAIN`, then `SUCCESS` 0.4 s later, as on 2026-10-20. The paid call (without
    `returnImmediately`) held about 64 s and returned the task in `TASK_STATE_WORKING`. The agent never delivered: the
    task still read `TASK_STATE_WORKING` 15 minutes later, past its window, so a task's state need not end when its
    payment can no longer settle. At a final block 879 past the delegate's `max_block_height`, the payment key's nonce
    was below the delegate's and its balance unchanged: **not charged**, the outcome `resolution.ts` decides from those
    facts. The paid case (relay timing) remains unobserved. The same run showed a partner-portal key reading an agent
    created under a key issued before the portal.
  - *Second run, 2026-11-09, `ai-gen-text-detector`, same setup:* refused at the paid call with
    `invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout`: the prototype signed for exactly
    `maxTimeoutSeconds` from the latest block (near-kit's `blockHeightOffset`), and the market reads an earlier
    height. The refused payment stayed relayable until its expiry; at a final block 886 past it, the key's nonce
    was unused and its balance unchanged: not charged. Now reproduced in the simulator and signed 60 blocks under.
  - *Third run, 2026-11-09, `ai-gen-text-detector` (the market's managed runtime, which its docs call deprecated),
    signed 60 blocks under the window:* the market accepted the payment and returned the task, `TASK_STATE_CANCELED`
    34 s later with no reason and no output. At a final block 8 past the delegate's `max_block_height`, the key's
    nonce was unused and its balance unchanged: not charged. The paid case remains unobserved.
  - *Fourth run, 2026-11-09, `luigi-check` (self-hosted), same setup:* accepted; the task stayed
    `TASK_STATE_WORKING`, its status unchanged from 21:29 UTC through and past the payment's expiry. Past
    `max_block_height` the key's nonce was unused and its balance unchanged: not charged.
  - *Fifth run, 2026-11-09, `multi`, our own self-hosted agent, re-priced for the test, hired from the same payer
    (paying an agent one owns was not refused):* the hire reached the agent as an `instant` job's assignment, held at
    `escrowToken` `X402`, whose id equals the A2A task id. The paid call held 63 s and returned
    `TASK_STATE_SUBMITTED`. Our worker submitted with its agent token at 22:25:23 UTC; the market accepted the
    assignment 7 s later, with no acceptance window. By the next final block we read (22:25:32), the payment key's
    nonce had reached the delegate's and its balance had dropped by exactly the amount: **paid**, relayed at delivery
    as the docs say, and the outcome `resolution.ts` decides. `GetTask` then read `TASK_STATE_COMPLETED` with the
    deliverable.
  - *Conclusion:* the market hands x402 hires to the agent and settles on delivery. The earlier non-deliveries were
    those agents not working their hires. Every outcome, paid and not charged, read from the chain as `resolution.ts`
    reads it. The paid call can return `TASK_STATE_SUBMITTED` as well as `TASK_STATE_WORKING`.
- **S2 (2026-11-10 UTC, user-reported local-prototype run):** the market refused a fresh deposit address because it
  was not registered on USDC. The owner registered it, retried withdrawal, and the prototype's Agent API status read
  `SUCCESS` at 02:10:31 UTC. This supports that one earnings-return path after registration, not a platform-hosted
  observation. Exact payment identities and amounts stay in the private record. See [mainnet log](mainnet-log.md#market-earnings-return-local-prototype-2026-11-10-utc).
- **S3 remains unresolved:** the user supplied assignment copy saying the hire was accepted and released less a
  marketplace fee, but no ledger `payout`/`platform_fee` entries. The reported withdrawal did not establish the expected
  fee deduction. Assignment copy alone does not resolve that discrepancy.

## Not decided

- **Competitions and standard jobs.** x402 covers hiring a listed agent; posting to the board needs a market account
  (MCP or the web), so it isn't reachable from the platform today.


### Omitted receipt recovery (0.5.9)

A final transaction response can omit its first receipt when signer and receiver are the same account
([NEAR RPC reference](https://docs.near.org/api/rpc/transactions)). Funding proof reads at most 16 omitted
receipt IDs, only when the final transaction already names their outcomes, through `EXPERIMENTAL_receipt`.
Each returned ID and receiver must match that outcome's executor. Every outcome must still have a receipt;
all existing finality, recipient, asset, amount and later-view requirements remain. Unavailable or mismatched
reads keep funding unresolved. Synthetic tests cover recovery and refusals (`test/market-funding-proof.test.ts`).
A private offline replay of two historical payout withdrawals also passed with separately captured exact RPC
receipts on 2026-11-12. This is historical payout evidence, not deployed Market top-up qualification.

## Funding without a hire

A private owner-run [funding observation](market-funding-proof.md) exercises the bound withdrawal stages without a live hire. Its two stages were mainnet-observed on platform staging on 2026-11-13, deployment `36fdd8a8-24ee-4503-956b-03d49ddc557b`, with independent final receipt and later chain checks; see the [dated observation](mainnet-log.md#controlled-market-funding-on-platform-staging-2026-11-13-utc). Its durable funding-only marker keeps landed funds reserved. This does not establish a platform-hosted hire or clear legacy keys; missing provider destination evidence still requires funding review.
