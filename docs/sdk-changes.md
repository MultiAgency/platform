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

## 0.5.5 (unreleased)

- **`payment.terms.chain`** (addition): an `approval_vote`'s proven terms in `owner/prepare` carry `chain: "near"` when
  the held payment is a withdrawal to a NEAR account, and nothing for a transfer. Optional, so older apps and servers are
  unaffected.

Platform changes in this release, outside the package:
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

## 0.5.4 (2026-11-08)

No change to the package's API.

Platform changes in this release, outside the package:
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
  - `steward/propose`: an app's own agent proposes with `proposals/create`.
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
