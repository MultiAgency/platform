# @multiagency/sdk changes

Every SDK change appends a note under the next version's heading when it is made: what changed for the apps, and any
wire change all apps must update for together. The first change after a release moves `package-version.ts` to the next
version, so a package staged or packed from changed sources never carries a released version's number. The release
commit dates the heading, before its candidate runs; staging copies this file as it is.

Versioning under 0.x: removing or renaming anything, or narrowing what a call accepts, bumps the minor version.
Additions ship as patches: new procedures, exports and accepted inputs, and new result kinds, including one that
reclassifies a case a client used to report under another kind. An entry that can break a consumer's exhaustive
`switch` on `kind` is marked **Breaking for exhaustive switches**; pin an exact version if you rely on one. This is
looser than the TypeScript convention, which counts a new result kind as breaking. Entries name what changed for apps;
platform-only fixes are listed separately.

## 0.5.8 (unreleased)

- **The `app-server` skill says to derive a payout's `requestId`, payee and amount in code** (docs): from the app's own
  record of what is owed, never from what a model or an incoming message proposes, and lists a model choosing them as a
  critical mistake. In the [crash test](crash-test.md), models given the SDK call without the skill sent a second payment
  under a new `requestId` when a tool result said the first had failed or was pending (14 of 46 runs, simulated provider).
  No API change.
- **An approve vote lists earlier payouts of the same terms** (addition): `owner/prepare` for an `approval_vote` with
  `verdict: "approve"` answers `payment.repeats`: this agent's payouts of the same payee, asset and amount (and flow) in
  the last 24 hours, read from the provider's history, as `{ checked: true, payouts: [{ correlationId, at, status }] }`,
  or `{ checked: false }` when that history couldn't be read whole. Settled, released, held and failed payouts count
  (a provider `FAILED` isn't proof nothing moved); a refund doesn't. The confirm page shows it beside the terms. It refuses
  nothing. Optional, so older apps ignore it. Offline-, browser- and stack-tested.

Platform changes in this release, outside the package:
- **The books attribute a wNEAR deposit** (staging, 2026-11-11): a deposit's asset was proven only by a NEP-141
  `ft_transfer` event to the deposit address, and wrap.near logs none, so a staging agent's 3 wNEAR deposit (wrapped and
  sent in one transaction, 2026-11-06) read as unattributed in `reconcileBooks`. A successful `ft_transfer` call of the
  deposited amount to the deposit address now proves it too (not `ft_transfer_call`, whose receiver can return the
  tokens), and either proof must agree with the asset the API's request names, or the deposit stays unattributed.
  Offline-tested against the observed transaction's receipts (`test/ledger.test.ts`); after deploy, that agent's wNEAR
  should read 0 unattributed.
- **The stack's simulated provider has a real agent's rows**: its starting and later funds as deposits (with the
  token's transfer on the stack's one chain), each swap's provider request with its amounts in `evidence` and its
  audit events, and shields in `/history`, each shaped as observed on staging except the shield row (none observed).
  A funded, shielded and swapped stack agent reconciles to zero (`test/e2e/stack-app.spec.mjs`), read through the new
  `reconcileBooks` stack control.

## 0.5.7 (2026-11-11)

- **A DAO's `market` consent covers its market agent's own owner actions** (platform#67; the user's decision,
  2026-11-11): under a DAO consent carrying `market`, `owner/prepare` with `signer: "dao"` files the market agent's
  `market` grant, the grant's revocation, freeze, unfreeze, and a policy edit of `limits`, `budget` and
  `max_actions_per_hour` only, which may raise, lower or remove those caps (`daoMarketMayAsk`, `DAO_MARKET_POLICY_FIELDS`). Before, they needed `treasury`, so a DAO
  with the read+market consent couldn't grant its market agent. Other policy fields, and owner actions on any agent that
  isn't a market agent, still need `treasury`. Each is still a proposal the DAO votes on. Offline-tested
  (`test/app-dao.test.ts`).
- **A quote for an agent the market can't hire is refused with a code** (reclassification; **Breaking for exhaustive switches**,
  platform#66): `market/quote`, and the re-quote inside `market/hire`, answer `refused` with `agent_not_found`
  (the market's `-32001`), `agent_not_hireable` (`-32004`) or `quote_refused` (`-32602`). Before, `market/quote`
  answered `unavailable`, which tells an app to send the call again, and `market/hire` answered `refused` with
  `hire_failed`. Any other market error answers as before. Nothing is sent. Offline-tested (`test/market-hire.test.ts`).
- **A prepare refused because an owner action is open says so** (addition, platform#70): a hosted agent's creation
  asked for while one is still open is refused `code: "owner_action_open"` (was an uncoded refusal); find the open one
  with `owner/pending`. Another owner action preparing a delegate at that moment answers `busy` (was an uncoded
  refusal), so retry shortly. Offline-tested (`test/owner-action-open.test.ts`).
- **`payoutDouble` refuses what it doesn't model** (platform#69): an unmodelled procedure, `market/*` among them, is
  refused with `code: "not_modelled"` (was HTTP 501, which the client read as `unavailable` or `unknown`, telling a test
  to send it again). `double.unmodelled()` still lists them. Offline-tested (`test/payout-double.test.ts`).
- **One requestId, one DAO hire** (platform#70): `daoHires.file` for a `requestId` already filed with the same terms
  answers that request (200, both `transactions` null, no new proposal) while it is relayed, signed or still within its
  vote; with other terms it is refused `request_conflict`, a new `AppGatewayCode` (**Breaking for exhaustive switches**).
  Before, each filing made a new proposal, even for a hire already paid (passing it moved nothing). One that lapsed
  unsigned is filed anew. Offline-tested (`test/app-dao.test.ts`).
- **One owner action of a kind at a time** (addition): `owner/prepare` refuses a second owner action of a kind with
  `code: "owner_action_open"` while one is submitted, or a DAO's is still open and unexpired, as it already did for a
  hosted agent's creation. A freeze and an unfreeze hold each other; a vote is held only by a vote on the same held
  payout (`approvalId`); every other action by its type. A wallet's prepared intent that was never signed holds nothing,
  and a settled or expired one holds nothing. Find the open one with `owner/pending`. Offline-tested
  (`test/owner-action-kinds.test.ts`).
- **`overview` reports the strategy's cash floor** (addition): `cashFloor: { usd, assets }` beside `target`, absent when
  the saved strategy has none. The output schema is loose and the field optional, so an older server's answer still
  parses. Offline-tested (`test/provider-display.test.ts`).
- **Docs:** the app-server skill says how a DAO hire filing shortens `validUntil` (the earliest of the request, the
  consent's expiry and `MAX_HIRE_APPROVAL_MS`) and that the answer carries the date the DAO votes on (platform#70).
- **Treasury limit orders** (addition): a dedicated `treasury-orders` consent and SDK contract cover quotes, exact
  owner approval, guarded placement, live status reads and one-way cancellation. Order views include digests of saved
  approval or rejection signatures so a DAO vote relay can reconcile a lost HTTP answer without signing or sending
  again. This feature is absent from the tagged 0.5.6 package. Its platform path has offline tests; Treasury app release
  integration and live order lifecycle checks remain release gates. See [limit orders](limit-orders.md).
- **App host capability discovery** (addition): `appClient.capabilities()` reads the authenticated
  `GET /apps/v1/capabilities` route, including `treasury-limit-orders-v1` when the host can serve Treasury order routes.
  It grants no consent and does not verify an active agent release or provider support. Headless `/gw/me` remains absent.


Platform changes in this release, outside the package:
- **The local stack's simulated provider describes a market grant as one** ("Authorize the local market hires", where it
  said "work order payout"; platform#67's report), and the simulated market can list an agent that isn't taking calls
  (`outcome: "closed"`, answering `-32004`).
- **Calls carrying a signature have their own request budget** (platform#59): a setup, a consent and its nonce, an
  owner action's `owner/submit`, a limit order's approval or rejection, and the DAO request reads that relay a passed vote's signature no longer share a
  credential's hourly budget with its other calls; they draw on a second budget of the same size. Another tenant's traffic
  can't refuse them with a 429 inside the signature's window, and they still can't exceed a limit of their own. Each 429
  is logged with its budget and, when the path names one, its Organization (at most once a minute per credential and
  budget). No client change. Offline-tested (`test/app-access.test.ts`).
- **No Organization can use up an app's hour for the others** (platform#59): the shared budget keeps a slice (5% of the
  limit) for each other Organization seen in the hour, even one refused, until it has used that much; a call that would
  eat into what is still owed to the others is refused, and the slices kept back never exceed half the limit. An app
  serving one Organization keeps its whole budget. The 429 log line names why (`reason: "fair_share"` or `"limit"`). No
  client change: the SDK reports either as `rate_limited`. Offline-tested (`test/fair-share.test.ts`,
  `test/app-access.test.ts`).
- **A market hire keeps to the DAO's approval and to one requestId's terms** (#62): a DAO's approval deadline stops
  every new top-up or payment submission and paid-call retry; attempted payments with unknown outcomes stay poll-only.
  Earlier top-ups stay recorded if the final payment is refused. Once an x402 payment is recorded, reusing its
  requestId with different terms refuses `request_conflict`; a top-up alone doesn't yet bind that ID. Signing is
  followed by fresh lock, shutdown, durable release and market-grant-expiry checks before submission. These shipped
  after 0.5.6, which doesn't have them.

## 0.5.6 (2026-11-10)

- **Provider SDK 0.8.2** (was 0.8.0), pinned exactly with a version-scoped release-age exception. Reviewed against
  official SDK source `416597b0c63a426b225b98b6d175c03bfb6a7947` and Agent API skills `0b81bba6` (2026-11-10).
  **Breaking for exhaustive switches:** policy reads and owner previews may carry `actions: ["limit_order", ...]`
  and optional `limit_order.max_deviation_bps`. The platform preserves this evidence and retains it during unrelated
  policy edits. This does not add order placement/cancellation, native EVM/Solana signing, app scopes or default policy
  permissions. New upstream error descriptions do not change our proven-refusal classification. See
  [provider SDK upgrade](provider-sdk-082.md) for source review, coverage and limits.

- **Hosted-agent release** (addition, #46): wallet owners may relay `agent_archive` and `agent_restore` under `owner`
  consent. After owner-signed freeze/archive, `appClient(...).release(organization, agent, { allowBalance? })` returns a
  hosting slot after executor checks and a durable send refusal, ends its consents and stops its process. The same
  owner-signed setup restores its retained provider identity with a new platform nonce and fresh consent; the owner
  separately unfreezes/restores. `reservations` may include `released: true`; released identity/RPC calls answer
  410 `agent_released`, a new `AppGatewayCode` (**breaking for exhaustive switches**). Balances refuse unless explicitly
  retained, including the market payment key's native NEAR and USDC. No state is deleted. Additive state/rollback notes
  and evidence are in `docs/agent-release.md`. Offline- and stack-tested; provider archive/restore semantics are per
  pinned docs, with no platform mainnet release observation. DAO release and agent deletion remain unavailable.

- **`agent_archive` and `agent_restore` are owner actions** (addition, platform#46): `owner/prepare` accepts both, and an
  app may relay them under `owner` consent like a freeze. They are the provider's reversible retirement: per its docs
  (Agent API skills at `ce381df`, `references/owner-intents.md`) an archive needs a frozen agent, changes nothing on
  chain and makes the provider refuse the agent's operations; a restore reverses it once the agent is unfrozen. Both are
  NEP-413, signed in the app. `agent_delete` stays out. Offline-tested (`test/agent-archive.test.ts`,
  `test/app-access.test.ts`); no archive is recorded on mainnet. Wallet owners only; a DAO's archive comes later.

- **Market hires** (addition; docs/market.md; offline-tested, not yet observed through the platform): a `market` area
  (`AREAS`; set up by an app only, `FRONTEND_AREAS` are the owner frontend's), role (`AGENT_ROLES`) and grant label
  (`GRANT_LABELS`), and a `market` app scope (`APP_MARKET`): `market/quote` (`marketQuoteInput` → `hireTerms`),
  `market/hire` (`marketHireInput`: a `requestId`, the brief, and the quoted terms it pays only while a fresh quote
  equals them), `market/status` and `market/account` (`marketAccountOutput`, with `registrationTransaction`, the
  owner's one-time registration of the agent's payment key on USDC), plus `deposit`. A DAO's consent may carry `market`
  (`DAO_CONSENT_SCOPES`), a DAO may set up a market agent (`DAO_SETUP_AREAS`), and it approves each hire by vote:
  `appClient(...).daoHires.file` and `.state` (`/apps/v1/dao-hires`, `appDaoHireFiled`, `appDaoHireState`) file the
  DAO's proposal from `hireText` and relay its signature once to `market/approve` (`marketApproveInput`), which no app
  scope reaches. New refusal code `brief_mismatch`. Capability `market-hire-v1`.
- **A journal operation may be `x402`** (`OPERATION_METHODS`): a market hire's payment. An SDK before 0.5.6 refuses a
  market agent's journal reads (`activity`, `unresolved`) and owner outputs naming `area: "market"`; no other agent's.
- **`payoutDouble` answers with the platform's own code** (no API change): the journal's answer to a payout request
  (`state`, `code`, `failureCode`, `neverExecuted`) is one pure function, `src/payout-answer.ts`, that the agent and
  `@multiagency/sdk/testing`'s double both run, where the double had a copy. `test/payout-double.test.ts` still runs
  every scenario against both.
- **The packed SDK is checked under Bun:** `pnpm sdk:bun` installs the release tarball in a scratch consumer and, under
  Bun (1.4.2 in CI), runs the skills' examples, loads every entry but the Node-only release server and runs a
  `payoutDouble` payout through `appClient` with an app's own `fetch`. It passed with no SDK change. Offline only
  (docs/testing.md).

Platform changes in this release, outside the package:
- **Full hire ceiling:** the policy's USDC per-transaction limit now applies to the full approved hire price, including
  retained payment-key funds. An over-cap hire is refused before opening or funding the key; every dispatch rechecks
  it before signing, including after a cap change during top-up. Funding already completed remains recorded and
  retained. Offline-tested; no new mainnet claim. Cumulative caps and budgets still count provider withdrawals,
  not later payments from retained funds.
- **Market agents** (docs/market.md): a market agent's settings file holds its payment key, written once at reservation
  (`docs/operations.md`); self-service setup and the owner frontend's discovery leave market agents out. A hire's
  payment goes through `dispatch` → `send` as an `x402` operation, judged by `authorize`'s `market` purpose (the user's
  decision, 2026-11-09), and resolved from the chain by reconciliation. A build before 0.5.6 can't read a journal
  holding an `x402` line. Downgrade below 0.5.6 is unsupported after the first market reservation or other shared market
  record: an older registry reader rejects the shared file and prevents the entire gateway from starting, not only
  market agents (`docs/operations.md`, mixed-host compatibility regression). Hosted agents
  receive `MARKET_URL` and `MARKET_MAX_WINDOW_SECONDS` from the gateway. The NEP-413 text check Treasury proposals use
  moved to `nep413.ts`, shared with hire approvals; unchanged in behaviour.
- **A held payout the provider names no approval for counts toward the waiting limit:** filing an invoice answers
  `busy` at 10 payouts waiting for the owner. That count left out a payout held (`PENDING_APPROVAL`) without an
  `approval_id`, which `held` can't list for a vote but dispatch still reserves funds for. It now counts every payout
  this agent holds. Offline-tested (`test/invoice-durability.test.ts`).
- **Two proposals created at once can't both pass the open-proposal limit:** the count of open proposals is taken again
  after the quote and the proposal saved with no wait between, so concurrent creations in one agent process store at
  most 32 open. Offline-tested (`test/treasury-proposals.test.ts`).
- **The autopilot reads what blocks after recovery from the journal:** when recovery marks an invoice `UNKNOWN` (its
  status read answered for another operation), the tick now skips as unresolved, as for any blocking operation, where
  it went on and failed at the money lock. Nothing was sent either way. Offline-tested (`test/autopilot.test.ts`).

## 0.5.5 (2026-11-10)

- **Docs** (no code change): the owner-workflows skill says how to follow a `policy_update` after `SUCCESS` (read
  `overview` until `APPLIED`, synced and above the prepared revision; keep reading on `SIGNED`; stop on `FAILED`). The
  app-server skill says how a Node or Bun server trusts the local stack's self-signed certificate.
- **Recovering a lost setup reply** (addition; Covenant, MultiAgency/demo#6): `appClient(...).reservations({ organization,
  owner?, area? })` (`GET /apps/v1/agents?organization=`, `appReservations`) lists the hosted agents this deployment's
  setups reserved for that Organization, with each one's owner and area. An app whose `setup` reply was lost learns its
  agent's name this way once the signed setup has expired; before that, sending the same body again already answers the
  same agent and setup consent (now tested). It lists only the calling deployment's reservations, makes no chain read,
  and reserves or signs nothing; setup itself is unchanged and an expired setup is still refused. A platform before
  0.5.5 answers `refused` 404. Offline-tested (`test/app-access.test.ts`, `test/hosted-gateway.test.ts`).
- **A payout request may opt out of `duplicate_held_payout`** (addition, platform#50): `payouts/request` accepts
  `allowDuplicateHeld: true`. Such a request skips only the refusal of a payout repeating the recipient, asset and amount
  of one already held for the owner; every other check applies, and each held payout still needs the owner's vote, which
  is then the only check between equal ones. For apps whose `requestId`s already make each payout unique. Absent, nothing
  changes. A platform before 0.5.5 drops the field and keeps refusing. `payoutDouble` honours it. Offline-tested
  (`test/authorize.test.ts`, `test/payout-requests.test.ts`, `test/payout-double.test.ts`).
- **A provider refusal while preparing an owner action is `provider`, not `unknown`** (reclassification, platform#54):
  `owner/prepare`'s only provider write is `generate-intent`, which executes nothing until the owner signs and
  `owner/submit` sends it, and nothing is recorded before it. So any provider failure there now reaches the app or owner
  client as `kind: "provider"` with the provider's code (for example the local stack's `unsupported_by_simulator`),
  where it was `unknown` unless its code was one proven to have executed nothing. `owner/submit` is unchanged.
  Offline-tested (`test/owner-contract.test.ts`); the gateway forwards the agent's typed answer unchanged.
- **`treasury/setConfidential` is removed** (platform#41): `treasury/get` reads whether a linked DAO is confidential from
  chain, so nothing sets it. A DAO is confidential when `intents.near.public_keys_of` holds its key on Trezu's path, the
  DAO's own name (`v1.signer.derived_public_key({ path: <dao>, predecessor: <dao>, domain_id: 1 })`), which Trezu's
  confidential setup registers; an account that isn't a DAO never is. A chain read that fails fails `treasury/get`; it
  never answers `false`. The procedure leaves `OwnerInputs`, `ownerOutputs`, `owner-treasury-v1`, `APP_TREASURY` and
  `DAO_APP_REFUSED`, and a host on this version refuses it, so an app drops its call before moving to this platform.
  `TREASURY_CONFIDENTIAL` in an agent's settings is no longer written or read. This removal ships in a patch version,
  by the user's decision, although the rule above bumps the minor version. Offline-tested (each answer and each failed
  read) and stack-tested: the stack's `daoConfidentialSetup` control registers the simulated DAO's key. Mainnet
  observation (2026-11-08) matched both keys for agentic.sputnik-dao.near.
- **`steward/propose` is removed**: the experimental LLM steward left the platform, which keeps no model of its own in
  the money path; an app's own agent proposes with `externalPlan` or `proposals/create`. The procedure leaves
  `OwnerInputs`, `ownerOutputs`, `ownerStreams`, `treasury-plans-v1` and the proposer permissions, and a host on this
  version refuses it. A stored plan the steward proposed keeps `source: "steward"`, which `Plan` still accepts; nothing
  saves a new one. This removal ships in a patch version, by the user's decision (2026-11-09), although the rule above
  bumps the minor version.
- **A payout to a payee the policy doesn't agree to is refused before sending** (behaviour): `payouts/request`, and
  any transfer under a payout or invoices grant without an invoice (such as the owner session's `pay`), answers
  `state: "refused"`, `code: "payee_not_agreed"` for a recipient that isn't an agreed confidential payee of an `only`
  policy, as a withdrawal already was. Before, the request reached the provider, whose refusal
  (`policy_destination_denied`, not a proven refusal) left it `unknown` and blocked the agent's later payouts until
  resolved ([crash test](crash-test.md)). Offline- and stack-tested.
- **Consent nonces** (addition, and a refusal after a wallet stop; patch by the user's decision):
  `appClient(...).consents.nonce()` asks the platform for a NEP-413 nonce (`POST /apps/v1/consent-nonces`,
  `appConsentNonce`) for the owner to sign a consent or setup text with, in place of one the app picks. The text itself
  is unchanged. After the owner's wallet stop covers an agent, a consent or setup for it is refused with the new code
  `owner_stopped` unless the platform issued its nonce after the stop, since otherwise it may have been signed before.
  Until a stop, an app's own nonces work as before. **Breaking for exhaustive switches** on `AppGatewayCode`.
  Offline-tested (`test/app-access.test.ts`).
- **`phase` on owner actions** (addition): `owner/status`, `owner/pending` and `owner/actions` each carry `phase` (`open`,
  `expired`, `submitted`, `settled`; `ownerActionPhase`), one name for where the action's record stands. Their own words
  disagreed: `owner/status`'s `submitted` is `owner/actions`'s `settled`, and its `submitting` is `submitted` there. Those
  words are unchanged; an app reads `phase` instead. Optional, absent from older servers and from `owner/status` for an
  action the server has no record of. Offline-tested (`test/owner-intent-lifecycle.test.ts`).
- **`payment.terms.chain`** (addition): an `approval_vote`'s proven terms in `owner/prepare` carry `chain: "near"` when
  the held payment is a withdrawal to a NEAR account, and nothing for a transfer. Optional, so older apps and servers are
  unaffected.
- **`payouts/status` under `read`** (addition, platform#53): `APP_READS` includes `payouts/status`, so an app that
  keeps a `read` consent can follow its payout requests after its `payout` consent ends. It answers only the app's own
  requests (keyed by `app:<deployment>:<organization>` and `requestId`); `payout` still covers it. The owner signs the
  same consent text; what `read` covers is listed in docs/app-access.md. Offline-tested (`test/app-access.test.ts`).
- **`failureCode` and `neverExecuted` on `payouts/request` and `payouts/status`** (addition, platform#49): a request
  that reads `failed` carries the provider's `failure_code` and `neverExecuted`, true only when the provider's status of
  that operation reads FAILED with `details.never_executed` and no transaction, intent, delivered amount or refund (per
  the provider's docs, an owner's rejection of a held payout). False proves nothing; REFUNDED never reads true. Answering
  a `failed` request reads the provider's status once; an unread status answers null and false. Other states carry
  null and false. Optional in `payoutRequestOutput`, so older apps and platforms are unaffected. Offline-tested
  (`test/payout-requests.test.ts`); not mainnet-observed.
- **`grant_issue` takes an optional `expiresAt`** (addition, platform#47): an ISO timestamp at least an hour
  (`MIN_GRANT_MS`) and at most 365 days (`MAX_GRANT_MS`, the provider's maximum) ahead, so a grant can end with a
  contract longer than the default 30 days (`DEFAULT_GRANT_MS`). Outside that range
  `owner/prepare` is refused before anything reaches the provider; it is never clamped, so the owner signs the expiry the
  app asked for. Without it a grant lasts 30 days, as before (`DEFAULT_GRANT_MS`); under a work order only the order's deadline is accepted.
  `owner/prepare` answers `grant: { label, expiresAt }` for a grant (the top-level `expiresAt` stays the signing
  window), and a DAO's grant proposal names the grant's expiry. Wallet, app and DAO-vote preparations all take it; the
  `pnpm issue-grant` CLI doesn't. The agent stops using a grant past its expiry (`authorize`, `grant_missing`); that the
  provider refuses its sends then is per the provider's docs (Agent API skills `references/grants.md`), not observed on
  mainnet. Optional on input and output, so older apps and servers are unaffected; a server before this version drops
  the field and issues a 30-day grant, so an app that relies on the expiry checks `grant.expiresAt` in the answer before
  the owner signs. Offline-tested (`test/grants.test.ts`, `test/work-order-binding.test.ts`, `test/app-dao.test.ts`).
- **`@multiagency/sdk/testing`** (addition, platform#52): `payoutDouble`, an in-process stand-in for one app's payout
  agent behind `/apps/v1`, for an app server's own tests (Node). The app passes its `fetch` to its own `appClient`; it
  answers `payouts/request`, `payouts/status`, `held` and `overview` over the same oRPC wire, with the gateway's
  `session`, `no_consent` and `scope` denials. It runs the platform's own `authorize`, mandate digest, payout policy
  template and input schemas, bundled (with `@orpc/server`; it imports only zod and `@orpc/contract`); the order of a
  request's checks and the journal's answers are restated, and `test/payout-double.test.ts` runs every scenario against
  the double and the agent's real procedures and requires the same answers. Controls set the policy and its provider
  state, the grant and balances, vote on and settle (`SUCCESS`, `FAILED`, `REFUNDED`) a held request, lose the next
  answer, and declare recipients absent, unregistered or unchecked. Budgets, hourly or monthly limits, approval expiry,
  outages, owner actions and other procedures aren't modelled (501, listed by `unmodelled()`). One platform answer
  the double makes plain, which apps' own fakes have differed on: a request without a live `payout` or `invoices` grant
  is refused `grant_purpose_denied` (never `grant_missing`). No other entry loads it.
- **A confirm link for votes on held payouts** (platform#48, addition): through an app, `owner/prepare` for an
  `approval_vote` also answers `confirm: { url, expiresAt }`, a page on the platform's host that shows the payout's terms
  as the platform proved them and lets the owner sign there with their own wallet. The answer still carries the
  `intent` and `signer`, so an app that ignores `confirm` works as before; send the owner to the link, and follow the
  outcome with `owner/status`. Offline- and browser-tested.
- **A payee's own terms, from the platform host** (addition, platform#51): `payeeClient({ base: "https://<host>" })
  .policyProof({ disclosure, read })` posts to `/confirm/v1/payee-policy` and answers `payeePolicyProof`: the payee's own
  destination entries, the per-transaction caps of the assets the agent spends, `owner_approval`, `frozen`, whether the
  policy is in force, and its revision, read from the provider's current policy; never other payees, budgets or other
  limits. `disclosure` is the wallet owner's NEP-413 signature over `payeeDisclosureMessage` (host,
  owner, agent, provider ID, payee; at most 366 days; optional `discloseDigest: true`), which an app has the owner sign and hands to the payee; `read`
  is the payee's over `payeePolicyReadMessage` (at most an hour). New exports, in both entries: those two builders with
  their parsers, `payeePolicyRequest`, `payeeTerms`, `payeePolicyProof`, `PAYEE_POLICY_PATH`. The answer carries
  `policy.digest`, the mandate digest of the provider's current policy, only when the owner's signed disclosure sets
  `discloseDigest: true`; otherwise the field is absent. The default leaves it out because the digest commits to the
  whole policy: a payee who can guess the rest of a simple policy could confirm the guess and learn its caps and budget.
  It is the owner's choice: the opt-in is in the signed text, so an app can't add it, and a disclosure without it is the
  same text as before. It is a read: a lost answer
  is `unavailable`. The answer is the platform's account of the provider's policy, not independently checkable
  ([app access](app-access.md)). Offline-tested; needs a platform on this version.

Platform changes in this release, outside the package:
- **Full hire ceiling:** the policy's USDC per-transaction limit now applies to the full approved hire price, including
  retained payment-key funds. An over-cap hire is refused before opening or funding the key; every dispatch rechecks
  it before signing, including after a cap change during top-up. Funding already completed remains recorded and
  retained. Offline-tested; no new mainnet claim. Cumulative caps and budgets still count provider withdrawals,
  not later payments from retained funds.
- **A wallet owner's stop may also freeze the agent** (the platform's own page, no app): a stop text ending
  `,"freeze":true` (absent is not asking; older texts are unchanged) has the platform prepare each created agent's
  `agent_freeze` through that agent's own `owner/prepare` (signer `wallet`) once the stop applies, and hand back the
  provider's intent unchanged, only if it is the owner's and, for NEP-366, calls only `freeze_wallet`. The owner's wallet
  signs it on `/confirm/wallet/stop`; `POST /confirm/v1/wallet-stop/freeze` (`{ stop, agent, signedData }`) checks the
  signature against the held intent and forwards it to the agent's `owner/submit`, and `/freeze-status` answers its
  `owner/status`. The signed stop is the only proof of ownership. The freeze is signable for 600 s (provider docs);
  unfreezing isn't offered there. New state: `.app-access/wallet-freezes/` (additive; stop records unchanged, so rolling
  back leaves the stop working and refuses only freezing texts). Offline-tested against agent servers on loopback and
  browser-tested with a stand-in wallet; signing with a real wallet untested; not deployed ([app access](app-access.md)).
- **The local stack's simulator issues a `payout` grant and refuses what it doesn't model** (platform#54): an agent the
  owner created (an app's hosted payout agent, a work order's) takes a `payout` grant as well as `invoices`, so
  `owner/prepare` of `{ type: "grant_issue", label: "payout" }` through an app is prepared instead of answering
  `unknown`. A grant the simulator doesn't model (another label, or a second grant for the configured agent) is refused
  in the provider's error shape, 400 `unsupported_by_simulator`, which reaches the app as a `provider` refusal, not a
  500. Offline-tested (`test/e2e-simulator.test.ts`) and stack-tested (`app-access.spec.mjs` now issues the app's payout
  agent a `payout` grant).
- **New stack controls** (platform#52): `signPayee` (a `--payee` or `--builder` account's NEP-413 signature over an
  app's own text, never the platform's sign-in text), `dropWithdrawResponse` (as `dropTransferResponse`, for
  withdrawals), `unregister` (a recipient not registered on a token, so a USDC withdrawal to it is refused
  `recipient_not_registered`), `settle` with `outcome` `FAILED` or `REFUNDED`, `expireApproval` (the platform then
  refuses a vote on it; what the provider does next isn't modelled) and `refuseNextPayout` (the provider refuses the
  next transfer or withdrawal under a named code, budgets among them, recording nothing; the simulator still counts no
  budget). Offline-tested (`test/e2e-simulator.test.ts`).
- **A DAO's vote on a proposal that is no longer open answers `proposal_not_open`** (409), not `agent_refused`. The
  agent refuses a verdict on a proposal that was invalidated, expired, withdrawn, rejected or already claimed, and always
  will, so reading the vote again can't change it; an app closes the request. Refused while the proposal is open, it's
  still `agent_refused`, and reading again relays the same signature, which completes a relay recorded before a crash.
  The gateway reads the proposal only after the agent refuses. Offline-tested (`test/app-dao.test.ts`).
- **Approving a held withdrawal:** an `approval_vote` approving a held withdrawal to a NEAR account is verified like a
  transfer's (the provider's request hash recomputed with `flow` `withdraw`, chain `near`, the current policy still
  permitting the withdrawal, its asset and that payee) and no longer refused `local_authorization_held`. The hash
  doesn't cover `destination_asset`, so the approval is refused unless it is the token withdrawn, and refused if the
  approval names any field outside the set observed on mainnet (2026-10-30). Offline- and stack-tested, not
  mainnet-observed ([enforcement](enforcement.md)).
- **Held payments on an approve-only copy:** `held` lists held withdrawals from the provider's history too, with
  `chain: "near"` in `request`, and only this agent's held payments (agents on one API key share history). It follows an
  empty history page that names a next one (it ended there and could list nothing), and reports a repeated page or more
  than 20 as incomplete instead of looping. The 20 pages (1,000 entries) count everything the history read returns,
  which may include other agents' entries on the same API key; past that, the held list says it's incomplete and changes
  nothing. Offline-tested.
- **The `platform` image installs production dependencies only:** `tsx`, the one devDependency the gateway runs (its
  entrypoint, and agents started with `--import tsx`), moved to dependencies, and `Dockerfile.platform` installs with
  `--prod`: 203 packages instead of 461, 645 MB instead of 778 (measured locally). The image check (two offline boots,
  the platform smoke checks, state kept) passed on it.
- **A read answers `invalidated` once the agent or the owner's strategy changed:** `proposals/get` and `proposals/list`
  close an open (`proposed` or `approved`) proposal whose agent or strategy no longer matches, with the reason approval
  gives (`the owner's strategy changed`), where they answered it open until someone approved or executed it. An app no
  longer offers the owner, or a DAO's vote, a proposal that can't pass. A changed policy is still found at approval and
  execution only, since reading it asks the provider. The strategy's digest covers the whole strategy, the autopilot's
  cadence and ceiling included, so changing those closes open proposals too. Offline-tested
  (`test/treasury-proposals.test.ts`).
- **A proposal past its validity ends as `expired` whatever is asked of it:** any call naming a proposal past its
  `expiresAt` stores it as expired first: `proposals/reject` and `proposals/withdraw` then refuse `not_open`, and one
  whose consent also ended reads expired, where they stored it as rejected or withdrawn. Two approvals racing with different signatures: the one recorded is
  answered `approved`, the other is refused `already_approved`, where both were answered `approved`. Offline-tested
  (`test/treasury-proposals.test.ts`).
- **An owner action's signing window closes at one moment in every view:** at `expiresAt` itself, `owner/actions`,
  `owner/pending` and `owner/status` say expired, as submission already refused it; they said it was still open for that
  moment. `owner/status` keeps answering `expired` once the record is dropped: for a wallet intent while the server runs,
  for a DAO intent after a restart too (from its archive), where it answered `unknown`. Offline-tested (`test/owner-intent-lifecycle.test.ts`, `test/owner-intents.test.ts`).
- **A work order whose agent creation was never signed can create it again:** a creation whose signing window closed
  before it was submitted, or that settled `EXPIRED` because the provider still awaited the signature, no longer blocks
  preparing another. Any other retained creation still does, `FAILED` included: what that leaves on chain isn't
  established.
  Offline-tested (`test/work-order-binding.test.ts`).
- **Operation and invoice payment statuses are read one way** (`src/operation-status.ts`): an invoice payment refuses a
  provider outcome before its submission claim, as the journal does, and a payout request reports status `UNKNOWN` as
  `unknown`. The run-log export reads every journal line the journal accepts (legacy request-with-status lines,
  status-less correlations, authorization metadata; withdrawals without their method, with a `method_not_exported` gap)
  instead of reporting malformed lines, and stops at its 20,000 records with a `journal_record_limit` gap.
  Offline-tested (`test/invoice-durability.test.ts`, `test/journal-history.test.ts`).
- **A completed DAO consent or setup answers the same after archiving:** `GET /apps/v1/dao-consents/<id>` and
  `/apps/v1/dao-setups/<id>` read the consent from `consents-ended/` once it is archived, so a revoked one still answers
  `signed` or `reserved` with `revoked: true`, where after 30 days it answered as if never completed (a setup that did
  reserve its agent could answer 410 "Nothing was done"). No new state. Offline-tested (`test/app-dao.test.ts`).
- **Dashboard:** a payment on its way (`QUEUED`, `SENT`) shows as processing; a DAO proposal that ended unapproved
  (`Rejected`, `Removed`, `Expired`) stops the vote step, while `Failed`, which can be finalized again, stays current;
  owner-action votes stop polling once submitted, expired or failed. Offline- and browser-tested.

## 0.5.4 (2026-11-08)

No change to the package's API.

Platform changes in this release, outside the package:
- **Full hire ceiling:** the policy's USDC per-transaction limit now applies to the full approved hire price, including
  retained payment-key funds. An over-cap hire is refused before opening or funding the key; every dispatch rechecks
  it before signing, including after a cap change during top-up. Funding already completed remains recorded and
  retained. Offline-tested; no new mainnet claim. Cumulative caps and budgets still count provider withdrawals,
  not later payments from retained funds.
- **A wallet owner's stop may also freeze the agent** (the platform's own page, no app): a stop text ending
  `,"freeze":true` (absent is not asking; older texts are unchanged) has the platform prepare each created agent's
  `agent_freeze` through that agent's own `owner/prepare` (signer `wallet`) once the stop applies, and hand back the
  provider's intent unchanged, only if it is the owner's and, for NEP-366, calls only `freeze_wallet`. The owner's wallet
  signs it on `/confirm/wallet/stop`; `POST /confirm/v1/wallet-stop/freeze` (`{ stop, agent, signedData }`) checks the
  signature against the held intent and forwards it to the agent's `owner/submit`, and `/freeze-status` answers its
  `owner/status`. The signed stop is the only proof of ownership. The freeze is signable for 600 s (provider docs);
  unfreezing isn't offered there. New state: `.app-access/wallet-freezes/` (additive; stop records unchanged, so rolling
  back leaves the stop working and refuses only freezing texts). Offline-tested against agent servers on loopback and
  browser-tested with a stand-in wallet; signing with a real wallet untested; not deployed ([app access](app-access.md)).
- **A request limit per app credential** (platform#15): the operator sets each credential's hourly limit, 1 to 12,000,
  at issue (`app-credential issue … --per-hour <n>`) or later in place (`app-credential limit <id> <n>`, same token,
  read on the next call); 1,200 stays the default and `list` shows each limit. A credential at the default stores no
  limit, so its record is unchanged; one with a limit set can't be read by 0.5.3 or earlier, so set it back to 1,200
  before rolling back to one. `Retry-After` after a lowered limit now counts until enough requests leave the hour (it
  named the oldest only). A limit per Organization isn't built. Offline-tested.
- **A wallet owner's own stop, with no app** (`/confirm/wallet/stop`, `POST /confirm/v1/wallet-stop`): one NEP-413
  signature over a canonical text, for one agent or every agent the wallet owns on the host, ends every app consent the
  owner gave for them before it first applies and turns their autopilot off. It doesn't freeze or revoke the grant.
  New state: `.app-access/wallet-stops/` (additive, inside the preserved `.app-access/`). Offline-tested, and on a
  headless gateway process for the route and the chain key check; the page is browser-tested with a stand-in wallet,
  and signing with a real wallet is untested ([app access](app-access.md)).
- **A send's refusal reads as a refusal, and never as the whole call's:** a send the platform refuses before sending it
  (`grant_missing`, `per_transaction_exceeded`, `policy_not_in_force` and the like) reaches the owner or app as `refused`
  with its `code`, where a plan whose first send was refused read `unknown`. A call that sends more than once never lets
  one send's refusal answer for it: a plan leg whose shield was sent and whose swap was then refused, by these checks or
  the provider, ends with the leg's event (`NOT_SENT`, the shield, `failureCode` naming the refusal) and `rejected`,
  where it ended as a refusal before any event; a proposal's execution answers with its view, `stopped`, listing what
  was sent and what was refused, where it answered `unknown` or a refusal. Offline-tested.
- **A release candidate releases the platform only:** `pnpm release:candidate -- --treasury-skill <dir>` packages
  `platform` (and the SDK with `--sdk`), no longer the prototype's `dao` and `invoices`, and needs no frozen app builds.
  The 16 E2E cases that tested the prototype's frontends (Invoices, Payables and the Treasury owner-session build)
  retired with its hosts; "invoice, owner approval, and settlement stay distinct" now approves through the owner
  procedures, and still catches both faults the challenge run injects into it. A full release candidate on these sources
  (Node 24.22.2, before commit) passed every gate: E2E 28 of 28, challenges 4 of 4; a first candidate on the same
  sources stopped at one unexplained timeout in the challenges' baseline ([testing](testing.md)). `pnpm test:e2e:stack` no longer takes
  `--invoices-dist-release`.
- **What ships is declared, and the prototype's deploy files are gone:** `test/build-context.test.ts` names the one
  shipped package (`platform`: its packaging script, Dockerfile, Railway config and deploy files) and the local configs,
  and fails on any other Dockerfile, packaging script or deploy file. Removed: `Dockerfile.gateway`,
  `Dockerfile.payouts`, the root `railway.json`, `deploy/shared-frontends.json`, `deploy/dashboard-entrypoint.sh`,
  `scripts/package-shared-frontends.mjs`, `scripts/check-shared-image.mjs` and `scripts/test-shared-frontend.mjs`. The
  `dao` image's state-preservation check went with it, replaced by `pnpm check:platform-image` for the `platform` image:
  built as Railway builds it, then inside it with no network, the packaged bytes, two boots of the real entrypoint and
  config passing the platform smoke checks, and every state directory and file unchanged. Every release candidate runs
  it on the package it produced, as its last gate, so a candidate needs Docker; it failed as it should on a tampered
  package and on an entrypoint that deleted `.ops`.

## 0.5.3 (2026-11-06)

- **Refusal codes from the app routes** (addition): the gateway names why it refused, and `appClient` passes it on as
  `code` on `refused` and `forbidden`, and on a gateway `forbidden` from an agent call (`OwnerFailure` gains `code` on
  `session` and `forbidden`). New exports: `APP_GATEWAY_CODES` and `AppGatewayCode`, grouped by what the app does next,
  and `gatewayDenialCode`. Agent calls' 403s now also declare `scope` (`agent` or `procedure`), and the one 403 that
  merged three cases is split: `owner_changed`, `agent_changed` (a new consent is needed) and `scope` (no consent covers
  the procedure). A gateway's coded 4xx on an agent call (for example `signature_invalid` on a relayed proposal
  signature) is now `refused` with its `code`, no longer `unknown`: nothing reached the agent. Older gateways send no
  `code`, and a plain answer without one stays as before. Offline-tested.
- **A gateway stopping during an agent call is no longer `forbidden`** (reclassification): it answered 403 "Access
  ended before forwarding"; it now answers 503, so a read reads `unavailable` and a mutation `unknown`, with nothing
  forwarded. `forbidden` with `access_ended` still means the credential or consent ended during the call.
- **`AbortSignal` on the app routes** (addition): `identity`, `setup`, `consents.*` and `dao*.file`/`state` take
  `{ signal }` (`AppRouteOptions`); an aborted call is `unavailable`.
- **Narrowing `owner/prepare`** (addition): `isDaoPrepared` and `isWalletPrepared`, with `AppPrepared`,
  `AppDaoPrepared` and `AppWalletPrepared`.
- **Proposal refusal codes** (addition): `PROPOSAL_REFUSAL_CODES` and `ProposalRefusalCode` list every code the
  proposal procedures send; the treasury-app skill lists the six it was missing.
- **`proposals/create` refusals carry their code and numbers** (reclassification): with `legs: "strategy"`, a refusal
  while picking the strategy's legs (a stale price, a strategy change during observation, no grant) is now `refused`
  with `not_proposable`, like explicit legs; it was `refused` with no code. An agent with no grant now refuses
  `proposals/create` (`not_proposable`, either kind of legs) with "This agent has no grant: the owner must issue one
  before it can quote or send."; it was an untyped server error, read as `unknown`. An explicit leg's floor and
  cost refusals now name the requested floor and the quoted output, or the quote's worst-case cost and the owner's
  limit in bps, with the leg's amount and asset ids, all raw. Offline-tested.
- **A cash floor in the strategy** (addition; platform#23, Treasury ADR 4): `strategy/save` accepts an optional
  `cashFloor: { usd, assets }`, whole USD of the named assets' public and confidential balance. `strategy/get` and the
  strategy snapshots type it. The platform refuses a swap that would lower that cash and leave it under the floor, on
  every path a swap is sent: the autopilot (scheduled and "Run now"), `executePlan` and proposals. It never refuses a
  swap that adds cash. Cash counts the named assets less what sends held for the owner's vote would take from them. A
  refused plan stops with `cash_floor_exceeded` in its journal. A proposal is also checked before
  its claim, so a refusal that check foresees is `not_executable` and the proposal stays approved; a price move before
  the send can still refuse a swap after the claim. Left out, there is no floor, and a strategy saved
  without one keeps its digest, so existing grants stay valid. A DAO's Treasury grant proposal lists the floor among
  the strategy's terms, which makes it public. A server that predates the floor drops the field: check that the
  strategy `strategy/save` answers carries it. Offline-tested; not deployed.
- **`treasury/get` balances are raw** (**Breaking for apps that display `balances.near`**; narrows the output): by the
  rule above this would bump the minor version; it ships in a patch because its only consumers are MultiAgency's own
  Treasury frontends. The change is on the server, so a pinned SDK doesn't shield an app: every app sees raw yoctoNEAR
  once its host runs 0.5.3. The Treasury app formats it from its next release; the `dao` package's Treasury pages don't
  (README, "Not done yet"). `balances.near` was near-kit's formatted NEAR with
  two decimals (`"305.53"`); it is now the account's yoctoNEAR as an integer string (`view_account` `amount`, including
  what storage reserves), like `balances.usdc` (6 decimals) and every other amount on the wire. The schema accepts only
  integer strings for both and states their units. An app that shows `balances.near` as received must format it with 24
  decimals. Offline-tested.
- **Docs:** the README opens app servers with a quickstart on the platform's local stack (a consent and a read, no
  wallet or funds), points to the credential request process for staging, and states the stack's prerequisites; its
  example no longer fails on a holding without a price. getting-started says `unavailable` on any app route means the
  same request is safe to send again (DAO filings included), and which outputs carry `bigint`. app-server decides
  consent refusals by `code`. app-access.md's polling advice fits the request limit.
  treasury-app says where the cash floor holds and where it doesn't. app-access.md and treasury-app say the strategy's
  per-run ceiling (`autopilot.maxUsd`) binds only autopilot runs, not `treasury-execute` plans.

Platform fixes in the same release, outside the package:
- **Each hosted agent keeps its own Treasury proposals** (`.proposals/<agent id>/`). Agents of one host shared one
  directory: an app holding consents on two agents of one Organization read both agents' proposals under either
  consent, a `requestId` reused on the second agent was refused or withdrew the first agent's proposal, and the 32 open
  proposals were counted across the host. Records from earlier builds stay where they are and are read by their own
  agent only ([operations](operations.md)).
  Offline-tested.
- **A consent is no longer stored after its deployment's credential was revoked** during the signer's key check, which
  a later credential under the same name would have inherited.
- **Shutdown doesn't cut a send:** on SIGTERM an agent starts no new send (refused as busy, before its record) and waits
  up to 25 s for the one in flight, while its work-order executors drain; a plan or proposal not yet claimed when the
  stop begins claims nothing, so an approved proposal stays approved. An autopilot run stopped partway reports what it
  sent. The gateway's Railway config sets `drainingSeconds: 45` (Railway's default kills at once), and invoices' 30.
- **App access state stays bounded:** consents are read from memory and re-read only when their directory changes (5,000
  records: 111 ms a call before, 0.2 ms after, measured locally); `app-credential archive-consents` moves consents ended
  over 30 days ago to `consents-ended/`; the access log is one file a month (`access-YYYY-MM.jsonl`).
- **Provider SDK 0.8.0** (was 0.7.3): accepts the partner portal's opaque API keys, which replace the provider's
  retired ones ([credential rotation](credential-rotation.md)); none of its breaking changes touch this code.
- **Rollback notes corrected:** DAO consent records carry no `filedAt`; only 0.4.1 and earlier refuse them.
- **The `platform` package serves the confirm page** (platform#28): it now carries the confirm entry of the web build's
  manifest, which a headless gateway reads to serve the page's assets. Packages built before had none, so the page
  loaded blank (seen on staging 2026-11-06).
- **Dependencies refreshed for Dependabot alerts** (lockfile only): seroval 1.7.7 (web frontend, through TanStack
  Router; its flaws are in server-rendering serialization, which the single-page app doesn't use),
  systeminformation 5.33.19 and fast-uri 3.1.9 (development only, through the shadcn CLI). elliptic, deepmerge and
  minimatch have no fix in range and were dismissed with reasons.

## 0.5.2 (2026-11-05)

- **More owner actions a DAO votes on through an app** (addition): `DAO_APP_ACTIONS` gains `grant_revoke` and
  `policy_update`, off-chain and on-chain edits alike, for parity with wallet owners, who also sign an on-chain edit's
  encrypted policy on the provider's preview. An edit that changes nothing is refused. `AppDaoAction` gains both. A DAO's proposals are public, so a policy edit's proposal
  names the changed fields only, never values; members compare `policy.current` and `policy.requested` from
  `owner/prepare` in the app. A revocation's proposal names the grant and its label. Each is a provider owner intent
  with about 290 s to pass, or 600 s for an on-chain edit, so only a DAO whose vote passes that fast completes it.
  Offline-tested only.
- **A 429 is `rate_limited`, with `retryAfterSeconds`** (new result kind; **Breaking for exhaustive switches**): the
  gateway's request-limit answer now carries
  `Retry-After` and `{ error, retryAfterSeconds }`. `appClient`'s routes reported it as `refused` and agent calls through
  `ownerClient` as `unavailable` or, for a mutation, `unknown`, though nothing was forwarded. Both now answer
  `{ kind: "rate_limited", status: 429, error, retryAfterSeconds? }`: send the same call again once it clears. A 429 that
  isn't the gateway's JSON (a proxy page) keeps its old kind (`refused` on the routes; `unavailable` or `unknown` on agent
  calls). The limit itself stays 1,200 requests an hour per app credential.
- **Docs:** getting-started states when sending again is safe (the same identity is, a new one isn't), including
  `proposals/approve`, `proposals/execute` and filing DAO requests, and routes app servers to app-server and
  treasury-app.

Platform fixes in the same release, outside the package: revoked app consents no longer count toward a deployment's
limit, and proposals valued at market prices are stored (they failed to save before).

## 0.5.1 (2026-11-04)

Additive procedures for owner UIs (platform#17), funding through the `treasury` scope, plus two fixes: an over-cap
payment is refused locally where it used to block the agent's sends, and policy outputs type `native`. All additions,
so a patch.
- **The `treasury` scope reaches `deposit`** (behaviour): under a `treasury` consent, a DAO's included, `deposit`
  answers a one-time address that credits only the agent's own confidential balance, so an app can fund the Treasury
  agent it reaches. A DAO's consent can't carry `payout`, so before this an app had no way to fund a DAO-owned agent
  (found on platform staging, 2026-11-04). `APP_TREASURY` gains `deposit`.
- **`account`** (added, `read`): `{ agentId, executor, wallet, grant, stagedGrant }`. It gives the agent's wallet
  account (the NEAR account holding its balances) and the grants this executor holds. `grant` is the one in use, and
  `stagedGrant` a newly issued one whose token isn't promoted yet; each is `{ id, label, expiresAt }` or null.
  - **Matched by token:** each grant is matched by its token's credential, never picked from the grants list. An
    approve-only copy names none.
  - **Pure, unlike `setup`:** it adopts nothing. A staged token is promoted by the owner-intent watcher, which every
    agent runs every 10 seconds, once the grant's owner action settles. `setup` stays owner-session only.
- **`reconcileBooks`** (added to `read`): each balance against its independent record, the chain for public and the
  provider's executions for confidential. It sends nothing.
- **`autopilot/tick`** (added to `treasury`): "Run now", one autopilot pass under its usual
  guard (one tick at a time, shared with the schedule). It swaps only under a grant that binds the saved strategy, and
  within that strategy's per-run ceiling, for a DAO's voted grant as for a wallet's. Its evidence start line records the
  app (`actor`, optional, so readers on 0.5.0 and earlier strip it).
- **`treasury/link`, `treasury/unlink`, `treasury/setConfidential`** (added to `treasury` for wallet owners): the agent's linked treasury account. Refused under a DAO's consent (`DAO_APP_REFUSED`,
  `daoScopesCover`): a DAO-owned agent's link is the DAO, fixed at setup, and the agent itself refuses a hosted DAO
  agent's relink (`checkHostedTreasury`).
- **`fundingTransaction(asset, address, amount)`** (added to the SDK, moved unchanged from the platform): the transfer
  `treasury/fund` answers (register the deposit address on the token, wrap NEAR, pay), for an address from `deposit`.
- **Not in app access:**
  - `setup`: use `account`, with the identity and `instance`.
  - `recover`: the platform reconciles unresolved operations itself every 10 seconds (#14). Apps read `unresolved`.
  - `treasury/fund`: use `deposit` (under `treasury`, above) and `fundingTransaction`.
  - `steward/propose`: an app's own agent proposes with `proposals/create` (removed from the platform in 0.5.5).
- **Policy outputs type `native`, not `sign`** (schema): the Agent API replaced the policy's `sign` block with `native`
  (provider SDK 0.5.3). Policy outputs now declare `native` with its `near`, `evm` and `solana` blocks, each required
  when `native` is present, as the provider documents. A policy still carrying `sign`, or a chain block added later,
  passes through as before.
- **Payments over the per-transaction cap are refused before sending** (behaviour): a payout, invoice or approval
  above the policy's `limits.per_transaction` for its asset is now refused locally with code
  `per_transaction_exceeded` (a payout request: `BAD_REQUEST`, `data.kind: "refused"`) instead of reaching the provider. The provider documents that refusal under a code the platform doesn't treat as
  proof nothing was sent, so it used to pause the agent's sends until reviewed (docs/enforcement.md).

## 0.5.0 (2026-11-04)

- **DAO consent** (added; offline- and stack-tested, not on any host yet): a DAO-owned agent's consent is signed by the DAO's
  own vote. `app.daoConsents.file(message)` files the canonical consent text and answers the proposal a member files
  (`proposal`, or `proposalAndVote`); `app.daoConsents.state(id)` answers `pending` until the DAO's signature is found on
  chain, then the stored consent. A DAO's consent carries only `DAO_CONSENT_SCOPES` (`read`, `treasury`, and `treasury-execute` as
  the DAO's opt-in). Under it the app reads, saves strategy settings, sweeps, creates and executes proposals, and turns
  autopilot on and off; with `treasury-execute` it runs plans too. Autopilot and plans swap without a vote each time,
  only under the grant the DAO voted for the saved strategy, whose proposal says so. The app can't sign or submit owner
  actions itself. `appAgent` and `appConsentView` gain an optional
  `signer` (`wallet` or `dao`; absent means `wallet`).
- **DAO votes** (added; offline- and stack-tested): `app.daoVotes.file({ organization, agent, proposal, verdict })` files
  the DAO's vote on one of the app's Treasury proposals from the platform's own `proposalText`; `app.daoVotes.state(id)`
  answers `pending` until the DAO's signature is found, then relays it to `proposals/approve` or `reject` once and
  answers `relayed` with the proposal's state. Under a DAO consent with `treasury`, `owner/prepare` with `signer: "dao"`
  prepares `DAO_APP_ACTIONS` (the `treasury` grant, freeze, unfreeze): the app gets the proposal a member files, never an
  intent; the agent submits the DAO's signature once the vote passes, and the app follows `owner/status`. Those are
  provider intents that expire in minutes, so only a DAO whose vote passes within `expiresAt` completes them. The grant
  is stack-tested; freeze and unfreeze by DAO vote are offline-tested only.
- **DAO setup** (added; offline- and stack-tested): `app.daoSetups.file(message)` files a DAO's setup text
  (`setupMessage` with the DAO as owner, area within `DAO_SETUP_AREAS`, at most 7 days) for its vote, refused (403)
  before anything is filed on a host that doesn't set up that area;
  `app.daoSetups.state(id)` answers `pending`, then `reserved` with the hosted agent and its setup consent. Under it the
  app asks only for `agent_create` with `signer: "dao"` and no owner (the DAO's derived account), a second vote that
  must pass within the intent's minutes; then it files the DAO's consent naming the new agent's ID.
- **Skills**: app-server gains "A DAO owner" (consent, setup and owner actions by DAO vote, members gated with
  `accessOf` and `mayCall`); treasury-app gains "A DAO-owned treasury" (proposal votes; the grant vote authorizes
  unattended swaps).
- **DAO stop** (added; no SDK change): a DAO stops its agent by its own vote, with no app. Anyone opens
  `https://<host>/confirm/dao/stop/<dao>/<agent>`, which files the stop or shows the one open. Once the vote has passed,
  opening it again applies it: it revokes every app consent for the agent given before then, ends every consent request
  filed by then (its `daoConsents.state` answers 409, whatever its vote), and turns its autopilot off. Consents the DAO
  gives after the stop applied stay live. An app's calls under an ended consent answer `forbidden`. Records from 0.5.0
  on can't be read by earlier builds: see app access, "Rolling back".
- **DAO requests** (behaviour): a signature found once completes the request on a later read only until what the DAO
  signed expires (410 after). A vote must pass while the DAO consent it is filed under is live, and is filed under the
  longest-lived one. A deployment files at most 256 DAO requests a day; a finished request is removed 30 days later, and
  its `state` then answers 404.
- **Treasury grant proposals** for a DAO name the strategy they bind (digest suffix and terms), and no longer point
  members to a dashboard: they compare the hash with the `v1.signer` call.
- **Voter check page** (added; no SDK change): each DAO request's proposal description links to
  `https://<host>/confirm/dao/<hash>`, a public page showing the exact text the DAO's key signs and its NEP-413 hash
  recomputed. Show members that link.
- **Also added to the SDK**: `AppSigner`, `DAO_APP_ACTIONS`, `appMayAskDao`, `AppDaoAction`, and the response schemas
  `appDaoConsentRequest`/`Filed`/`State`, `appDaoVoteRequest`/`Filed`/`State`, `appDaoSetupRequest`/`Filed`/`State`.
  `AppInputs["owner/prepare"]` is now `{ action: AppOwnerAction; signer: "wallet" } | { action: AppDaoAction; signer:
  "dao" }`: code that assumed `signer: "wallet"` narrows on `signer` first.
- **Behaviour a 0.4.1 app sees**: `GET /apps/v1/agents/<agent>` answers a DAO-owned agent (200, `signer: "dao"`) where it
  answered 404. `POST /apps/v1/setup` still answers 409 for a DAO owner, now naming `/apps/v1/dao-setups`.
- **DAO roles** (added): `accessOf`, `groupOf`, `permits`, and the `DaoPolicy`, `DaoRole` and `ConfiguredOwner` types,
  the platform's own reading of Sputnik roles (moved from the gateway, unchanged). An app reads the DAO's `get_policy`
  and gates each member's calls with `mayCall(accessOf(account, owner), path)`: Group members only, `strategy/save` only
  for a member who may change the DAO's policy. The platform doesn't check members under a DAO's consent; the app does.

## 0.4.1 (2026-11-03)

No code, type or wire change.

- **README and npm description**: both open with what the platform is, a control plane for agentic treasuries built
  on NEAR Intents; the description names the app-server client.
- **treasury-app**: where the limits are: the owner's policy, enforced by the provider on every path, in absolute
  amounts; no consent or credential has a budget of its own, and limits in an app's own process aren't a boundary.
- **getting-started**: the app row lists the `treasury` and `treasury-execute` scopes and when to ask for each; the
  machine row says it is reached through `ownerClient`, isn't extended, and is retired once Treasury moves to app
  access. Digests (`expectedPolicy`, `expectedDigest`) are read from the platform and passed back, never computed.
- **app-server**: how an app stops quickly: stop any autopilot it turned on first (revoking doesn't), revoke its
  consent, relay `agent_freeze`, and treat anything `executing`, `processing` or `unknown` as possibly sent.

## 0.4.0 (2026-11-02)

Additive: 0.3.x apps keep working, and a consent signed without the new scopes stays valid.

- **Treasury proposals** (`proposals/create`, `get`, `list`, `approve`, `reject`, `withdraw`, `execute`): an app proposes
  swaps under its own `requestId`; the owner approves the exact terms later by signing `proposalText(proposal, "approve")`
  (NEP-413, recipient the platform host); the app then asks for one execution, which re-quotes every swap and sends each
  with a floor at least the signed one, through the same plan execution as any saved plan. A proposal lasts at most 7
  days. New exports: `proposalCreateInput`, `proposalSigned`, `proposalRef`, `proposalView`, `proposalList`,
  `ProposalState`, `proposalText`, `tokenAmount`, `PROPOSAL_TOKENS`, `MAX_PROPOSAL_MS`, `MAX_OPEN_PROPOSALS`,
  `MAX_PROPOSAL_LEGS`.
- **Consent scopes `treasury` and `treasury-execute`** (`AppScope`, `APP_TREASURY`, `APP_TREASURY_EXECUTE`): `treasury`
  reaches Treasury reads, strategy settings, autopilot on and off, sweep and proposals; `treasury-execute`, only beside
  `treasury`, adds `rebalance`, `externalPlan` and `executePlan`, which run for an app only while the owner's live grant
  binds the plan's strategy.
- **`appClient(...).agent(...).stream`**: an app reads the stream procedures its consent covers (`sweep`, and with
  `treasury-execute` `rebalance` and `executePlan`), as `ownerClient.stream` does. `call` takes the other procedures.
- **Machine route (platform, not an SDK type):** `executePlan` through a Treasury machine credential (`tmc_`) now runs
  only while the owner's live grant binds the plan's strategy, as an app's does; under a plain `treasury` grant it is
  refused before anything is claimed. The owner signs the strategy-bound grant once per saved strategy. Clients of the
  machine route (the treasury app's helper) need that grant before upgrading the platform.
- **Plans:** a plan's `source` may be `proposal`, with its `proposalId`; such a plan runs only as its proposal.
- **Owner capability** `treasury-proposals-v1`.
- **treasury-app skill.**

## 0.3.1 (2026-10-31)

No code, type or wire change.

- **License: MIT** (copyright MultiAgency LLC).
- **README:** "What the platform does for your product": what the provider does, what the platform guarantees to an
  app and what the app still does, and what has run where for each client's routes.
- **app-server skill:** the platform's host serves only `/apps/v1` and the confirm page (no sign-in or owner page), and
  setup there is for Payables agents only. A vote the platform can't verify is refused before anything reaches the
  provider (`refused`, code `local_authorization_held`).

## Earlier versions

0.0.1 to 0.3.0: see the [changelog at sdk-v0.3.0](https://github.com/MultiAgency/platform/blob/sdk-v0.3.0/docs/sdk-changes.md).
