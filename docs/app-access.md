# App access

How an app's server reaches agents under `/apps/v1` with its service credential and each owner's signed consent: the
routes, consent and setup, what each scope permits, how owner actions reach the owner (NEP-413 in the app, NEP-366 on
the platform's confirm page), what a dishonest app can still do, and how each part is known. Builders start with
[building an app](integration-path.md) and the SDK's `app-server` and `treasury-app` skills; this page is the platform
side.

The platform's own host (`api.dev.multiagency.ai` for staging; `api.multiagency.ai` for production) runs the
`platform` package headless: only `/health`, these routes and the confirm page with its own assets. Staging permits app
setup for Treasury, Payables and market agents; production currently permits Payables only (`deploy/platform*.json`;
offline-tested in `test/platform-host.test.ts`, E2E on a headless
stack). Staging has run it since 2026-10-31 (read-only checks in [platform staging](platform-staging.md)); production
since 2026-11-07, with no app credential issued yet ([platform production](platform-production.md)). The `dao`
package serves these routes beside its owner app wherever it runs; its hosted prototype was retired on 2026-11-08.

An app deployment (for example the MultiAgency dashboard's `staging`) reaches agents under `/apps/v1` with its service
credential (`Authorization: Bearer
tap_<id>.<secret>`, no cookies or Origin). The operator issues it on the gateway host: `pnpm app-credential issue
<deployment> <host> [days] [label] [--per-hour <n>]` (1–365 days, default 90; the token prints once; the request limit
below), `list`, `limit <id> <n>`, `revoke <id>`, and for consents
`consents [deployment]`, `revoke-consent <id>` and `check-keys` (checks every live consent's signing key and revokes those
the chain reports removed; exits non-zero if any lookup went unanswered).

| Request | Result |
| --- | --- |
| `GET /apps/v1/capabilities` (SDK 0.5.8; rollout pending) | `{ capabilities: [...] }`: app route groups this host advertises for the calling deployment. `treasury-limit-orders-v1` means the platform can serve the order API for a Treasury area; it grants no consent and says nothing about an active agent release or deployed provider support. Requires the service credential; headless `/gw/me` still answers 404. |
| `GET /apps/v1/agents/<agent>` | `{ agent, owner, agentId, created, host, deployment, signer }`: what the owner's consent must name (`signer` is `wallet` or `dao`; `agentId` null and `created` false before the agent exists) |
| `POST /apps/v1/setup` with a signed setup text | `201 { agent, consent }`: reserves and starts this owner's hosted agent for the area, and a setup consent (below) |
| `GET /apps/v1/agents?organization=<org>[&owner=][&area=]` | `{ agents: [{ agent, organization, owner, area }] }`: the hosted agents this deployment's setups reserved for that Organization on this host, from the registry; how an app whose setup reply was lost learns the name (below) |
| `POST /apps/v1/consent-nonces` | `{ nonce, issuedAt }`: a NEP-413 nonce for the owner to sign the next consent or setup text with (see the wallet stop below) |
| `POST /apps/v1/consents` with `{ message, nonce, publicKey, signature }` | `201 { consent }`; responses omit the message, nonce and signature, which the record keeps (mode 0600) |
| `GET /apps/v1/consents[?organization=]` | This deployment's consents on this host |
| `DELETE /apps/v1/consents/<id>` | `{ revoked: true }`; this deployment's on this host only; permanent (below) |
| `POST /apps/v1/o/<organization>/a/<agent>/rpc/<procedure>` | Forwarded to the agent with actor `app:<deployment>:<organization>` |
| `POST /apps/v1/dao-setups`, `/dao-consents` with `{ message }`; `/dao-votes` with `{ organization, agent, proposal, verdict }` | `201 { request, transactions }`: the DAO's proposal for a member to file (`proposal`, or `proposalAndVote`) |
| `GET /confirm/dao/<hash>` (public, no credential) | The voter check page: the request's exact text, nonce and host, and whether its hash recomputes; plain HTML, no script |
| `GET /apps/v1/dao-setups/<hash>`, `/dao-consents/<hash>`, `/dao-votes/<hash>` | `pending` until the DAO's signature is found; then `reserved`, `signed` or `relayed` (410 once its vote window closed with no signature found, or once what it signed expired; 409 for a consent a DAO stop ended, and `proposal_not_open` for a vote the agent refuses once its proposal is no longer open) |

The consent text is exactly `consentMessage({ host, deployment, organization, owner, agent, agentId, scopes, expiresAt })`
(`src/contract/app-consent.ts`), signed with NEP-413 for recipient the host, with a 32-byte nonce and no callback URL.
It is refused unless it names this host and the calling deployment, expires between a minute and 366 days from now,
verifies, and the key is a full-access key of the owner now. The agent must be configured with that owner, and the owner
must be a wallet whose agent's server reports that owner and the provider agent ID the text names (the machine route's
check), so a signature held for an agent that was since replaced isn't attached to the replacement.

**Setup.** The owner signs `setupMessage({ host, deployment, organization, owner, area, expiresAt })` (at most an hour;
the same checks as a consent). A DAO owner gets 409 here and files its setup at `/apps/v1/dao-setups` instead (below). The platform then reserves the hosted agent for
that owner and area if the host's config lists the area in `appSetup` (independent of self-service `/gw/agents`; a demo
host also narrows it to its `hostedAreas`) and the registry has capacity, starts it, and stores a setup consent: `owner` scope with the reserved stand-in agent ID
`unborn`, which no signed consent may name. It acts only while the agent's server reports no agent created, so it serves the
owner's `agent_create` (prepared here, signed by the owner's wallet), which must name the key that signed the setup. Once
the agent exists the setup consent reads `owner/status`, `owner/actions` and `owner/pending` until it expires (at most an
hour): those cover every owner action of the agent in that time, not only its creation. A setup is refused when the
owner's agent for that area already exists and is created (409), or when that can't be checked (503); a setup whose
consent can't be stored (revoked, or the deployment's consent limit reached) reserves nothing.
**A lost setup reply.** Until the signed setup expires, sending the same body again answers the same agent and the same
setup consent: the registry returns the existing reservation for that deployment, Organization, owner and area, and a
consent is stored once per signature (also when the first attempt reserved the agent but stored nothing). Once it has
expired, `GET /apps/v1/agents?organization=<org>&owner=<owner>&area=<area>` answers the name from the registry. It lists
only reservations whose recorded scope is the calling deployment and that Organization, which its own setups (or a
DAO's setup it filed) caused, never another deployment's or an agent no app set up; it makes no chain read and reserves
or signs nothing. An expired setup text is never accepted again, so nothing new is reserved from it. The same read names
the agent after an `already_created` refusal. Then read `GET /apps/v1/agents/<agent>` for its identity; a setup consent
that has expired no longer relays its creation, so the owner signs a new setup (which finds the same reservation) if the
agent isn't created yet. Offline-tested (`test/app-access.test.ts`) and on a real gateway with a real reservation
(`test/hosted-gateway.test.ts`); needs a platform on 0.5.5 (an earlier one answers 404).
The owner then signs an ordinary consent naming the new provider ID. An app's setup reserves that deployment and
Organization's own agent, per owner and area (`.hosted/apps.json` records the scope), so Organizations sharing an
owner wallet don't share payees, budget or balance: each policy is signed and provider-enforced. Only that deployment
reads its identity, and only that deployment for that Organization stores consents for it and calls it, whatever consent
is signed, since a consent names the agent by a generated name its owner can't tell apart. The scope names the
deployment, not the host: give each app deployment a distinct name on every host. One deployment holds at most 16
Organization agents per host (`PER_DEPLOYMENT`), so it can't take the host's capacity. Since 0.5.6 a wallet-owned agent's reservation can be explicitly released after its owner signs archive,
freeing a slot (offline- and stack-tested, not deployed; [release](agent-release.md)). DAO reservations still have no release path (#46). Self-service setups
(`/gw/agents`) stay per owner and area. An ownership or key check that goes unanswered (the agent's server, a chain
read) is 503 on every app route: nothing is stored or forwarded, and the app reads again or resends the same body;
refusals (400, 403, 404, 409) are answers.

A revocation writes a tombstone, `.app-access/revoked/<id>`, which is never deleted: a revoked consent stays
revoked even if its record is archived, and its signature can't be stored again. The operator can revoke any consent by
id, including one whose record is already gone. Expired records may be archived; their text can't verify again. Each
deployment holds at most 1,024 live consents; a revoked one frees its place (#16).

A call is forwarded only with a live consent for that deployment, host, Organization and agent, bound to the agent's
current provider ID, whose signing key is still a full-access key of the owner, and whose scope allows the procedure. The
key is read with `view_access_key` at final finality on every call (`chainKeyState`, `src/signin.ts`): when the chain
answers that the key is absent or no longer full-access, the consent is revoked for good (tombstone reason `key-removed`
or `key-not-full-access`), so re-adding the key revives nothing; an unanswered lookup refuses the call with 503 and
revokes nothing. Read scope: `read` permits `instance`, `account` (0.5.1: the agent's wallet account and the grants this
executor holds, matched by token; it adopts nothing), `reconcileBooks` (0.5.1: each balance against its independent
record), `overview`, `policyHistory`, `activity`, `unresolved`, `held`, `ledger`, `ledgerCsv`, `owner/actions`,
`owner/pending`, `owner/status`, `paymentHistory`, `paymentStatus` and (0.5.5) `payouts/status`, which answers only
the app's own payout requests: the agent finds a request by the actor `app:<deployment>:<organization>` and its
`requestId`, so another deployment or Organization reads `not_found`. Its answer (state, provider status, operation
id, refusal or failure code) is what `activity` and `paymentStatus` already show under `read`, plus `neverExecuted`,
the provider's own flag on that operation (below). An app keeps
following its requests with `read` after its `payout` consent ends (platform#53; `test/app-access.test.ts`). Owner scope: `owner` permits `owner/prepare`, `owner/submit`, `owner/status`,
`owner/pending` and `owner/actions`, and nothing else (no reads beyond those). Payout scope: `payout` permits
`payouts/request`, `payouts/status`, `held` and `deposit` (a one-time address crediting USDC to the agent's
confidential balance, so the app can fund it; it moves nothing out): payout requests (CONTEXT.md, "Payout request"), each sent at most once
under the app's `requestId` and namespaced by the actor `app:<deployment>:<organization>`, judged as a payout
(`authorize`, then the provider's policy) and refused before sending on an agent whose grant is for other work. The
`held` read shows every held payout of the agent, not only this app's. With `owner_approval: false` an app with `payout` consent pays agreed payees
within caps and budget with no owner signature; that bound is the owner-signed policy. `owner/prepare` must name `signer: "wallet"`:
the owner signs in the app with their own wallet, and `owner/submit` verifies that signature against the prepared
intent (`src/owner-signature.ts`), so the app can prepare and forward but never complete an owner action alone.
Market scope (0.5.6, offline-tested; [agent market](market.md)): `market` permits `market/quote` (moves nothing),
`market/hire`, `market/status`, `market/account` and `deposit`, and nothing else that spends. A hire is paid at most once
under the app's `requestId` (namespaced by its actor, as a payout request is), only while a fresh quote equals the terms
the app sends, from the agent's payment key, judged as a `market` send in `authorize`; its outcome is read from the
chain. `market/account` shows the payment key and, until the owner registers it on USDC, the transaction for the
owner's wallet (`registrationTransaction`). `market/approve` is not in any scope: only the platform relays a DAO's
signed approval to it (below).
**The app chooses what it asks for, never what the owner reads** (`appMayAsk`, `src/contract/app-access.ts`;
`appMayPrepare` and the reply hold in `src/gateway/app-routes.ts`). The app may prepare `agent_create` without payees (the
policy is the platform's treasury or payout policy; the owner key must be the one that signed the setup),
`agent_freeze`, `agent_unfreeze`, `agent_archive` and `agent_restore` (0.5.6; per the provider's docs an archive needs a
frozen agent, changes nothing on chain and is reversed by a restore once unfrozen), `grant_issue`, `grant_revoke`,
`policy_update` of any field, and `approval_vote`. The gateway reads each prepared reply before releasing it:
- NEP-413 goes to the app unchanged: it is a text the owner's wallet can show (which wallets show it is not checked).
  A vote on a held payout is the exception: its text names no terms, so it carries a confirm link too, and the
  operator can withhold its text (below).
- NEP-366 (creation, freeze, unfreeze and on-chain policy edits, per the provider's docs) is held on the platform. The
  app gets `confirm: { url, expiresAt }` in its place, with no delegate bytes, and the gateway logs `confirm`. The URL
  is the platform host's confirm page, `/confirm/<token>` (128-bit token; the record in `.app-access/confirm/` is named
  by its hash). That page (`web/src/confirm.tsx`, a separate entry from the owner app, with no platform session) shows
  the requesting deployment and Organization, the agent and the action's terms from the agent's own record: for a
  policy edit every field that changes, before and after, as the agent built the request (so fields derived from what
  the app asked, such as transfers turned off with the last payee, show too); for a creation the whole policy;
  otherwise the action's fields. Anyone holding the link, the app included, can read those terms. The bytes to sign go
  only to a visitor who first signs the link's NEP-413 text with the key the action names (recipient the host). That text
  is plain words the wallet shows: it opens a MultiAgency confirm page, says to sign it only on
  `https://<host>/confirm/` and to refuse anywhere else, and names the link, deployment, Organization, agent, action and
  expiry. The page asks the wallet for that, then for the action. The gateway checks the action's signature against the held bytes
  (`ownerSignatureProblem`) and claims the link's one submission with an exclusive claim file before forwarding
  `owner/submit` to the agent as the app's actor (`confirmed` in the log). A wrong wallet or other bytes are refused
  without using the link; a used link answers 409 (also when the forward then failed: nothing was sent, and the app
  prepares the action again), an expired one 410. `/apps/v1` refuses `owner/submit` for an action held here. The app
  follows the outcome with `owner/status`. What remains: a dishonest app can read the link's text itself, ask the
  owner to sign it on its own page or a look-alike, then take the bytes, ask for a blind signature and post it to the
  link (reproduced offline, 2026-10-27). A wallet that shows NEP-413 text shows its warning wherever it is asked; heeding it,
  and checking the page's domain, is the last line, since the wallet can't show an encrypted policy.
- Anything else (another standard, an unreadable reply) is not released: 403, logged `withheld`, and the intent expires
  unsigned at the provider.
- Votes on held payouts: the agent binds `approval_vote` to the held payout's provider evidence before preparing and
  again under the money lock before submitting (`checkPaymentApproval`, `src/payment-approval.ts`): the approval and
  the held execution name each other and this agent's wallet, the approval's recipient, asset and amount hash to the
  provider's request hash, and an approve is re-authorized under the current policy. The prepared answer carries those
  proven terms (`payment`) for the app to show, and for an approve, the agent's payouts of the same terms in the last
  24 hours (`payment.repeats`, 0.5.8; `{ checked: false }` when the provider's history can't be read whole). What a dishonest app gains: a vote on another of this agent's held
  payouts than the one it showed, which is itself a transfer to an agreed payee within the caps; the power it would
  have if the owner had turned `owner_approval` off. The vote's signed text names no payee or amount: it is OutLayer's
  `approve:{approval_id}:{wallet_pubkey}:{request_hash}` (recorded 2026-10-11 on a payout agent,
  `.agents/skills/near-agent-api`), so the wallet can't show the terms.
- **The vote's confirm page** (#48; offline- and browser-tested with a stand-in wallet, not deployed): the prepared vote
  also answers `confirm: { url, expiresAt }`, a link to the same confirm page, which shows the payout's terms (payee,
  amount with its raw units and asset id, a confidential transfer or a public withdrawal to NEAR) as the agent proved
  them: the gateway takes them from the agent's `payment`, never from the app's request, and makes no link unless they
  name the payout and verdict the app asked about (an approve with terms, a reject with none; otherwise the app gets
  the vote as before, without a link). The app also gets the vote's text and signer, unchanged: the link is an offer,
  holds nothing, has no opening step, and the page signs that text directly (one wallet prompt), since its bytes are no
  secret from the app. The app may still submit itself, and of two submissions the agent sends the first and answers the
  second from its record. The page's submission is the agent's own `owner/submit` under the app's actor, so the money
  lock, the re-check of the provider evidence right before signing, and poll-only after an attempt are unchanged; the
  app follows the outcome with `owner/status`. Who reads the terms: anyone holding the link (128-bit token), the app
  included, which already holds them in `payment`; the page reads nothing else. What remains: the page is optional. A
  dishonest app can simply not send the owner to it and show other terms in its own page, and neither the owner nor
  the operator can require it. Rolling back: a gateway before this change can't read a vote's confirm record, so the
  vote links answer an error until they expire (minutes); the vote's text and `owner/submit` through the app are
  unaffected.
- Grants: `grant_issue` may name `expiresAt` (ISO timestamp, 0.5.5) to end the grant at a date the owner chooses instead
  of the platform's 30 days: at least an hour and at most 365 days ahead (the provider's maximum, per the Agent API
  skills and SDK 0.8.0 README), refused outside that range, never clamped; under a work order only
  the order's deadline (`grantExpiry`, `src/grants.ts`; `MIN_GRANT_MS`, `MAX_GRANT_MS` in `src/contract/inputs.ts`). The
  prepared answer names the label and expiry the agent asked the provider to sign (`grant: { label, expiresAt }`; the
  top-level `expiresAt` is the signing window), and a DAO's grant proposal names it too. The signed grant message
  carries the expiry (`expires_at_ms`; a payout grant's wallet prompt showed it on mainnet, [mainnet
  log](mainnet-log.md#app-access-on-platform-staging-2026-10-28-utc)), and the agent stops using a grant past its expiry (`isLive`, `src/grants.ts`; `authorize`
  refuses `grant_missing`). That the provider then refuses the grant's sends is per the provider's docs (Agent API skills
  `references/grants.md`: "Expired grants stop working by themselves"; `agent_grant_required` for an expired token),
  not observed on mainnet. Offline-tested (`test/grants.test.ts`, `test/work-order-binding.test.ts`,
  `test/app-dao.test.ts`). A new grant doesn't end the agent's earlier ones: revoke those (`grant_revoke`) to end their
  authority sooner.
- Refused before forwarding, under a wallet's consent: `signer: "dao"`, `agent_create` with payees, other owner actions
  (such as `agent_delete`), and anything that doesn't parse as the agent server would read it (oRPC's `RPCSerializer`,
  then `ownerPrepareInput`).

Before 2026-10-27 the app received the NEP-366 intents for creation, freeze and unfreeze and had the owner's wallet sign
them on its own page. A dishonest app could have handed the wallet another delegate action and relayed it on-chain
itself. Per `outlayer.near`'s source at `out-layer/outlayer@aaf60a2` (a deployed version is not assumed from source),
`store_wallet_policy` requires the agent wallet's own signature over the encrypted policy and the caller, which an app
doesn't hold, while `freeze_wallet` and `unfreeze_wallet` check only that the caller owns the wallet: an app could have
had the owner unfreeze any of their wallets while showing a freeze. Since the confirm page, an app gets those bytes only
with the owner's signature over the link's text, which tells the owner in the wallet to sign it only on the platform.

A NEP-413 message is readable only if the owner's wallet shows it; which wallets do is not checked here. Within the
allowed actions, the app still picks which one to ask for and when: a compromised app can ask the owner to
sign a readable grant or a destinations edit the owner didn't intend, but not hide its terms. These limits bind only the
app route: an app that asks the owner to sign the platform's own sign-in text (`Sign in to <host>`, NEP-413,
readable) gets an ordinary platform session for that owner. With it, it can move money with no further signature
(`pay`, `sweep`, `compensation/send`, `executePlan`, `autopilot/enable`; `src/contract/permissions.ts`), within the
owner-signed policy (agreed payees, caps, budget, held for approval where `owner_approval` is on), and prepare any owner
action, including opaque NEP-366 edits, for the owner to sign. The signature covers only the host and a nonce the
platform issued, so whoever fetched the nonce can relay it; the platform can't tell where it was signed. Whether a
wallet shows the recipient, or refuses one that doesn't match the requesting page, is not checked. Consents belong to the deployment name, not to one credential: a
credential issued again under the same deployment name acts on every consent that deployment holds.
The platform doesn't see the app's users: the app's own sign-in and roles decide which of its users act for which
Organization, so a fault there acts within every consent the deployment holds (for `payout`, within the owner-signed
policy). With `treasury`, an app reaches Treasury reads, strategy settings (which act on an app's or a machine credential's plans only once the owner's grant binds them,
[enforcement](enforcement.md#treasury-proposals-offline--and-stack-tested)), autopilot on and off, `autopilot/tick` (0.5.1: one pass now,
swapping only under a grant that binds the saved strategy and within its per-run ceiling; the tick's evidence names the
app), sweep, `deposit` (from 0.5.1: a one-time address crediting the agent, so the app can fund it; `fundingTransaction`
in the SDK builds the transfer), for a wallet owner the linked treasury account (0.5.1: `treasury/link`, `unlink`;
refused under a DAO's consent, whose link is the DAO, fixed at setup; `setConfidential` was removed in 0.5.5, since
`treasury/get` reads whether a linked DAO is confidential from chain) and proposals:
its swaps run only after the owner signs each proposal's exact terms (`proposalText`), a check the platform makes, not
the provider. With `treasury-execute` as well, it can prepare and execute plans within the policy and the strategy's
cost limit without a signature per swap, only while the owner's live grant binds the plan's strategy
([enforcement](enforcement.md#treasury-proposals-offline--and-stack-tested)). The strategy's per-run ceiling
(`autopilot.maxUsd`) binds only autopilot runs (purpose `autopilot`, `src/authorize.ts`); these plans are judged as
purpose `treasury`, so `maxUsd: 0` doesn't stop them. Scopes are separate: a consent carries each it needs. Agreements, invoices, compensation and work-order records are not
reachable. Each
consent, call and revocation is appended to `.app-access/access-YYYY-MM.jsonl`, one file per month (UTC; builds before 0.5.3 wrote one `access.jsonl`).

The 0.5.8 limit-order feature adds `treasury-orders`, which requires `treasury` in the same consent and covers only
`limitOrders/quote`, `create`, `get`, `list`, `approve`, `reject`, `place`, `cancel` and `refresh`. Existing `treasury`
or `treasury-execute` consents alone do not acquire these routes. The owner must separately sign the `limit_order`
policy opt-in and each exact order's NEP-413 text; the gateway checks the current owner's signing key before relaying
approval or rejection, and the agent checks the exact text. A placement still requires the executor's Treasury grant.
See [limit orders](limit-orders.md) for the in-progress, offline-tested path and its live gaps.

DAO owners: a DAO's consent is signed by its own vote (`POST /apps/v1/dao-consents`, then `GET /apps/v1/dao-consents/<hash>`
until the DAO's signature is found). It carries only `read`, `payout`, `treasury`, `market`, `treasury-orders` and,
as the DAO's opt-in, `treasury-execute` (`market` added by the user, 2026-11-09), and each call re-reads that the agent is still owned by the DAO's derived
account. The DAO's grant vote is what authorizes unattended swaps (autopilot, and with `treasury-execute` the app's
plans), within the strategy it binds and the DAO's signed policy; the grant's proposal says so. The platform authorizes the app, not a member: the app gates its own members with the
SDK's `accessOf` and `mayCall`, from the DAO's policy. Under it the app asks for the DAO's
votes: on its Treasury proposals (`POST /apps/v1/dao-votes`, relayed to the agent once the signature is found), on
each market hire under a consent carrying `market` (`POST /apps/v1/dao-hires` with the terms `market/quote` answered,
the brief and how long the approval may last; `GET /apps/v1/dao-hires/<hash>` relays the signature once to
`market/approve`, which checks the text, host and expiry and that the signing key is the agent's DAO owner as the
provider records it, then begins or resumes the bound hire, which may still await funding in the 0.5.9 candidate; a DAO-owned market agent
refuses a plain `market/hire`. In the 0.5.9 candidate, a repeated same-ID filing returns `repeated: true` and no
transaction by default. After inspecting the DAO for an earlier submission, send `recoverProposal: "dao-checked"`
to recover the original proposal transaction; an ended consent or changed signer blocks that recovery. An expired signed hire
approval that was not relayed can be filed anew with the same terms and request ID), on a market
agent's own owner actions under a consent carrying `market` (0.5.7, #67, the user's decision of 2026-11-11: its `market`
grant and that grant's revocation, freeze, unfreeze, and a policy edit of `limits`, `budget` and `max_actions_per_hour`
only, raising, lowering or removing those caps, `daoMarketMayAsk`; a cap can't move money by itself, since every hire
is paid only after its own vote and a top-up only to the payment key by what an approved hire lacks; other policy
fields, and every owner action on an agent
that isn't a market agent, still need `treasury`), on
each limit order under a consent carrying both `treasury` and `treasury-orders` (`POST /apps/v1/dao-limit-orders`
files an exact approval or rejection vote; `GET /apps/v1/dao-limit-orders/<hash>` relays the signature once to
`limitOrders/approve` or `reject` after checking the current agent and signing key; a durable relay claim makes later
polls read the agent's exact signature receipt only), and on
the `treasury` grant, revoking a grant, a policy edit, freeze and unfreeze (`owner/prepare` with `signer: "dao"`, which
answers the proposal to file; the agent submits the signature). An off-chain edit (`destinations`, `withdrawals`,
`budget`) is a readable NEP-413 message with about 290 s to pass; an on-chain edit (actions, assets, limits, approval,
`max_actions_per_hour`) is a delegate action with 600 s. For an on-chain edit the DAO relies on the provider's preview,
as a wallet owner does: its policy travels encrypted, so neither the platform nor a voter can check the bytes against
it. A `policy_update`'s fields each replace the policy's field whole, for every owner: `limits: { hourly }` alone drops
the other limit periods (`src/owner-requests.ts`, `policyChange`), so an app sends each field complete, starting from the
policy in force. Because
a DAO's proposals are public, a policy edit's proposal names only the fields it changes, never their values (payees, the
DAO's budget); `owner/prepare` answers the policy before and after (`policy.current`, `policy.requested`) for the app
to show its members. A revocation's proposal names the grant and its label. Revoking and policy edits through an app
are offline-tested only (from the next SDK release). A DAO sets up a hosted Treasury agent by vote too (`POST /apps/v1/dao-setups`,
then `agent_create` with `signer: "dao"` under its setup consent, a second vote within the intent's minutes). A
host that doesn't set up Treasury agents refuses it before filing anything, so no vote is spent on it.
**A DAO's own stop, with no app:** anyone opens `/confirm/dao/stop/<dao>/<agent>` (GET only; a pair this host doesn't
serve answers 404 before anything is read; at most 60 opens an hour per address and agent). The page files a stop the
DAO votes on, or shows the one already open, with the exact text, its hash, and the proposal to file (Trezu's custom
function call, or the whole transaction). Once the vote has passed, opening the page again applies it, and its cutoff is
that first moment: it revokes every app consent for the agent ID given before then, marks every consent request filed by
then so it is never stored, whatever its vote, and turns the agent's autopilot off. So a stop filed early, by anyone,
still ends whatever was given before it applies. Applied again until autopilot is confirmed off, it keeps its first
cutoff: a consent the DAO gives after the stop applied stays live. A passed stop is honoured whenever the page is next
opened, even after its window. Until then, autopilot and the consents it will end stay live. It only removes authority.
Offline- and stack-tested (simulated DAO votes). Mainnet-observed on platform staging on 2026-11-04 with
`agentic.sputnik-dao.near` ([mainnet log](mainnet-log.md#a-dao-owned-treasury-agent-through-an-app-on-platform-staging-2026-11-04-utc)): setup, creation, consent, the strategy-bound grant, autopilot on, and
the DAO's own stop; on 2026-11-05 ([mainnet log](mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc)), funding through
`deposit` by the DAO's vote and an app's proposal approved by DAO vote, then executed. Not observed: freeze and unfreeze.
Not in production.

**A wallet owner's own stop, with no app** (`src/gateway/wallet-stop.ts`): the counterpart of a DAO's stop, for agents a
wallet owns.
- **Signing:** on `/confirm/wallet/stop` (or `/confirm/wallet/stop/<agent>`), part of the confirm build, the owner
  connects the owning wallet (any wallet that signs NEP-413 messages) and signs the canonical text, recipient the host:
  `{"type":"multiagency.wallet-stop","version":1,"host","owner","agent","expiresAt"}`, ending `,"freeze":true` when the
  owner also asks to freeze (below; absent is the only form of not asking, so a stop without it is the text it was
  before). `agent` is one agent, or `"*"` for every agent the wallet owns on the host; `expiresAt` is at most an hour
  away, and the page renews its 10-minute text before it runs out. Anyone may send the signature to `POST /confirm/v1/wallet-stop`
  (`{ message, nonce, publicKey, signature }`), so any tool that signs NEP-413 works too; at most 60 sends an hour per
  address.
- **Checks:** the exact text, this host and the signature; then that the key is a full-access key of the owner now,
  before saying whether any agent of theirs is here; then each agent's owner as its server reports it.
- **Effect:** the stop's cutoff is the moment it first applies. Every app consent stored for those agents by then is
  revoked, whatever provider ID it names, and each created agent's autopilot is turned off. Sending the same
  stop again only retries an autopilot not yet confirmed off, even after the text's expiry; an agent found replaced or
  owned by someone else by then is reported and not asked.
- **Freeze, signed by the owner's own wallet on this page** (0.5.5): a stop whose text says `"freeze":true` also prepares
  each created agent's freeze, after the stop has applied. The signed stop is the only authorization: no freeze is
  prepared for a stop that fails a check above, for an agent the stop didn't name when it first applied, or for one whose
  server now reports another owner or provider ID (`replaced`, `owner changed`); the freeze can't be added to or taken
  off a signed text. The gateway asks that agent's own `owner/prepare` for `{ type: "agent_freeze" }` with
  `signer: "wallet"` (effectless: it only generates the provider's intent, for the agent's own provider ID, and the
  agent refuses a generated intent of another type), and hands the reply's intent and signer back in the stop's answer
  unchanged (`freeze: { state: "sign", correlationId, expiresAt, intent, signer }`) only if it is one the owner's wallet
  signs for that owner: signer the owner's NEAR account, inside its signing window, and, for NEP-366, only
  `freeze_wallet` calls (the provider's `unfreeze_wallet` checks no more than who signs, so this refuses the swap the
  confirm page exists for, above). Anything else is logged `wallet-freeze-withheld`, never released, and expires
  unsigned. Per the provider's docs freeze is NEP-366 (a delegate action); a NEP-413 freeze would be handed back as
  text the wallet shows. The page asks the owner's wallet to sign exactly that intent (a NEP-366 intent needs a wallet
  that signs delegate actions; a message-only wallet signs the stop but not the freeze, and the page says so). It
  posts the signature with the signed stop to `POST /confirm/v1/wallet-stop/freeze` (`{ stop, agent, signedData }`):
  the gateway re-verifies the stop's signature, finds the freeze that stop prepared for that agent, checks the signature
  against the held intent and the provider's owner key (`ownerSignatureProblem`, before anything is sent, so a wrong
  wallet or other bytes reach nothing), records when it first forwarded it, and forwards it to the agent's own
  `owner/submit` (owner action journal, provider verification, poll-only after an attempt, all unchanged).
  `POST /confirm/v1/wallet-stop/freeze-status` (`{ stop, agent }`) answers the agent's `owner/status` of it. Sent
  again, the stop hands back a freeze still within its window, says `submitted` for one sent, and prepares a new one
  for a lapsed one only while the stop text is unexpired (else `expired`: sign a new stop). Freeze submissions and
  status reads: at most 600 an hour per address. New state: `.app-access/wallet-freezes/`, one record per stop (named
  like its stop record), additive inside the preserved `.app-access/`; stop records are unchanged, so a gateway before
  this change reads them, and refuses a stop text with `"freeze":true` as not canonical.
  - **What it stops:** a frozen policy isn't in force, so `authorize` refuses every send (`notInForce`, offline-tested),
    and per OutLayer source the keystore re-checks the freeze on every signature (shared-tee-helpers@f75a74e, deployed
    version not established, [enforcement](enforcement.md#spending-limits-under-concurrency)). No freeze is recorded in the
    [mainnet log](mainnet-log.md). Unlike the stop alone, an app the owner consents to later can't send under the grant
    until the owner unfreezes.
  - **Window:** the provider's freeze intent is signable for 600 s (provider docs, [enforcement](enforcement.md#dao-owners-through-apps-offline--and-stack-tested)
    Limits); the page shows its expiry. A freeze signed after it is refused by the agent; the owner sends the same
    stop again within the stop's hour for a new one.
  - **Not offered:** unfreezing. The owner unfreezes through an app with `owner` consent (`agent_unfreeze`, on the
    confirm page) or the owner session; a stop page that also unfroze would hand a stop's signature a power it
    exists to take away.
- **Limits:** as for a DAO's stop, the stop itself only removes authority. Without the freeze the provider grant stands,
  so an app the owner consents to afterwards may turn autopilot on again, and with or without it a tick or forwarded call
  already running finishes through the guarded send path. A consent the stop revoked can't be sent again (its ID is its
  signature's hash).
- **Texts signed before the stop:** after a stop covering an agent (naming it, or every agent), a consent or setup for
  it is stored only if the platform issued its NEP-413 nonce after the stop's cutoff (`POST /apps/v1/consent-nonces`);
  otherwise it is refused `owner_stopped` (409) and nothing is stored (under a stop for every agent, a setup is refused
  before anything is reserved). The nonce holds its issue time, random bytes and
  an HMAC over both, keyed from the gateway's secret and bound to the host and deployment, so its time can't be changed
  or another deployment's used; nothing is stored for it. The owner's signature covers the nonce, as the platform already
  picks a DAO consent's nonce. Without a stop, a nonce the app picked is accepted as before. The check runs with no wait
  before storing, so a stop applying meanwhile either finds the consent stored (and revokes it) or is found. Changing
  `SESSION_SECRET` makes earlier nonces count as the app's own.
- **How it's known:** offline-tested (`test/wallet-stop.test.ts`), on a headless gateway process for the route and the
  chain key check (`test/platform-host.test.ts`), and in a browser with a stand-in wallet (`test/browser/wallet-stop.cjs`:
  the shown text is canonical and is what the wallet signs and the page sends; a retry resends it; a page left open
  renews it; a message-only wallet is offered; asked to freeze, the text says so, the wallet signs exactly the intent the
  stop handed back, and the page submits it with the signed stop and reads its status; a message-only wallet can't sign
  the freeze and nothing is sent). The freeze's gateway routes are offline-tested against agent servers on loopback
  (`test/wallet-stop.test.ts`: only the owner's full-access key gets one prepared, only `agent_freeze` is asked of each
  agent's own `owner/prepare`, a reply that isn't the owner's `freeze_wallet` is withheld, a wrong key, an unfreeze or
  another agent's bytes are refused before `owner/submit`, and the owner's signature reaches `owner/submit` and
  `owner/status` unchanged). Neither this page's freeze nor any freeze is recorded in the [mainnet log](mainnet-log.md).
  Signing with a real wallet is untested. Not deployed.

**A payee's own terms, with no app** (`src/gateway/payee-policy.ts`, platform#51): a payee reads the part of the
agent's policy that concerns them straight from the platform host, so an app (Covenant's contractor Verify page, say)
no longer has to relay `overview` through its own credential.
- **Authorization:** the wallet owner signs a payee disclosure (NEP-413, recipient the host):
  `{"type":"multiagency.payee-disclosure","version":1,"host","owner","agent","agentId","payee","expiresAt"}`, at most 366
  days (`payeeDisclosureMessage`, `src/contract/payee-policy.ts`), optionally ending `,"discloseDigest":true` when the
  owner also discloses the mandate digest (below). Absent is the only form of not opting in (`false` isn't canonical),
  so a disclosure without it is exactly the text it was before the opt-in existed. An app prepares it like a consent, from
  `GET /apps/v1/agents/<agent>`, has the owner's wallet sign it where the payee's terms are agreed, and hands the signed
  text to the payee. The platform stores nothing. For each read the payee signs
  `{"type":"multiagency.payee-policy-read","version":1,"host","payee","agent","expiresAt"}` (at most an hour) with a key
  of the paid account and sends both to `POST /confirm/v1/payee-policy` (`{ disclosure, read }`, each
  `{ message, nonce, publicKey, signature }`), from their own tool (`payeeClient({ base: "https://<host>" }).policyProof`):
  a browser request from another site's page is refused, as on every route that isn't a GET.
- **Checks, in order, before the agent is asked anything:** both texts canonical, naming this host, the same payee and
  agent, within their lifetimes; both signatures; each key a full-access key of its account on chain now (an unanswered
  lookup is 503 and reads nothing); the agent configured on this host with that owner, and the agent's server reporting
  it owned by that wallet with the provider ID the disclosure names (else 404, or 409 for a replaced or uncreated
  agent). At most 60 reads an hour per address. Each answered read appends `payee-policy` (owner, agent, payee, revision)
  to the access log.
- **Disclosed:** read by the agent from the provider's current policy (`getPolicy`, uncached) at `observedAt`: the
  payee's own destination entries (a transfer to their account, or a withdrawal to it on chain `near`, each with whether
  the policy's actions include it), whether they are an agreed payee, the destinations mode, the per-transaction caps
  of the assets the policy lets the agent spend, `owner_approval`, `frozen`, the revision, its status, when it applied
  and whether the provider is synced, and why it isn't in force (`notInForce`, the rule `authorize` refuses with). The
  mandate digest of that policy (`policy.digest`) only when the disclosure opts in; otherwise the field is absent, and
  the gateway drops it whatever the agent answers. Never other destinations, budgets, hourly, daily or monthly limits, usage, balances, the provider's
  `policy_hash` or the policy transaction. The gateway parses the agent's answer with the published schema
  (`payeeTerms`), which drops any other field.
- **What it establishes:** the platform host's account, over TLS, of what the provider reported to the agent: the app
  is out of the path, the platform is not. Nothing in it is independently checkable. Per the provider, the policy is
  stored encrypted (`outlayer.near` `store_wallet_policy`) and the on-chain `agent_policy_hash` isn't a function of it;
  the API's `policy_hash` (sha256 of the policy with sorted keys, reproduced for 15 revisions on 2026-10-13) is readable
  only with the platform's partner key and, like the mandate digest, needs the whole policy to recompute
  ([enforcement status](enforcement.md#status)). The revision lets a payee compare with the one they recorded after agreeing
  terms: the provider moves it on every policy edit (on mainnet each observed edit applied as the next revision,
  [mainnet log](mainnet-log.md)), so a different revision means the owner changed something, not
  necessarily their terms. The mandate digest is the owner's choice, made where they sign the disclosure. It commits to
  the whole policy and anyone can recompute it from a policy's JSON, so a payee who can guess every other field (an
  agent paying only them under a known template, say) can compute the digest of each guess and compare: a match confirms
  the guess, and with it the caps, budgets and other payees it contains. A payee who can't guess the whole policy learns
  nothing from it beyond what the revision shows: that the policy changed. Opting in suits an owner whose policy isn't
  confidential from that payee or a payee who must cite the exact policy; an app shows the owner this before they sign,
  and the opt-in is in the signed text, so an app can't add it (a changed text fails the signature). The answer isn't signed, so it isn't proof a payee can show a third party, and it says nothing about
  whether the provider enforces those terms (unverified, as for every policy).
- **Limits:** wallet owners
  only: a DAO signs only by vote, and no DAO request files a disclosure. With nothing stored there is no revocation
  record: a disclosure ends at its expiry, when the agent is replaced, or while the chain reports the owner's signing
  key removed or no longer full-access (re-adding the key revives it). A wallet stop ends app consents, not
  disclosures, and removing the payee from the policy doesn't end one: the answer then shows no entry.
- **How it's known:** offline-tested (`test/payee-policy.test.ts`: each check, the disclosed fields, that extra fields
  the agent returns are dropped, the digest only under a signed opt-in (an added opt-in fails the signature, an old
  disclosure text still verifies), the gateway-only agent read no owner, app or machine permission reaches, and the SDK
  client; on 2026-11-09 each check was removed by hand and the suite failed every time, a manual check, not part of the
  suite), and on a headless gateway process for the route (`test/platform-host.test.ts`). Not stack-tested; signing
  with a real wallet untested; not deployed.

**Funding through an app:** found on that run, a DAO's consent couldn't reach `deposit`, which was in the `payout`
scope only. From 0.5.1 the `treasury` scope reaches it too: offline-tested, and mainnet-observed on platform staging
on 2026-11-05, where the DAO funded its agent with the calls `fundingTransaction` builds, filed as one proposal. See
[enforcement](enforcement.md#dao-owners-through-apps-offline--and-stack-tested).

**0.5.6 market rollback boundary:** downgrading below 0.5.6 is unsupported after writing a market reservation, a consent
with `market`, a DAO market setup or hire request, or an `x402` operation. Older readers reject the shared market
reservation/scope/area/request kind; a single reservation can prevent the whole gateway starting, including Treasury
and Payables (offline mixed-host test with the actual 0.5.5 registry reader). Preserve all state and settings with
executors stopped and recover on a compatible build. No tested downgrade conversion exists; the historical notes
below do not authorize deleting or rewriting these records. See [market rollback](market.md#rollback).

Rolling back: records written from 0.5.0 on carry fields that earlier builds refuse to read, and one refused record
makes every app route answer an error:
- **DAO consents** in `.app-access/consents/` carry `signer: "dao"`, which 0.4.1 and earlier refuse (0.5.0 and later
  read it). Before rolling back to 0.4.1 or earlier, move the files whose record has `"signer":"dao"` out of
  `consents/` (losing DAO access only). Wallet consents are written as before and stay readable.
- **DAO requests** in `.app-access/dao-requests/`: a stop's `lapsed` and a consent request's `stoppedBy` are refused by
  088239e and before. Remove those fields, or keep the directory out of the earlier build (0.4.1 never reads it). Stop
proposals filed by those earlier builds link `/confirm/dao/stop/<agent>`, which now answers 404: open
`/confirm/dao/stop/<dao>/<agent>`, which shows the same open stop.

**One held payout per recipient, asset and amount (`duplicate_held_payout`).** A payout request is refused before
sending while any payment of the same agent with the same recipient, asset and amount is held for the owner's approval
(`authorize`, `src/authorize.ts`, over the agent's own operation records, `src/agent.ts`). It compares those three
terms only, across the whole agent: a different `requestId`, another app or deployment, or a held payment the owner
asked for doesn't make it another payout. The refusal is recorded, so that `requestId` reads `refused`; once the held
payment is no longer waiting (approved or rejected), the same terms go through under a new `requestId`. The rule keeps
one payout from being held, and then approved and paid, twice: it is one of the checks the provider can't make (the
provider's replay deduplication is unverified; README, "Not done yet"), and the only offline-tested part of the
[facilitator](facilitator.md)'s "can't pay twice" target. It stays the default (#50). A payout request may opt out with
`allowDuplicateHeld: true` (0.5.5), for an app whose `requestId`s already make each payout unique: it is then held beside
an equal one, and the owner's vote is the only check between them, as after the first settles (see enforcement,
"A second payout after the first settled"). Every other check still applies, and an older platform ignores the field
and keeps refusing (`test/authorize.test.ts`, `test/payout-requests.test.ts`, `test/payout-double.test.ts`). An app keeps at most one open request
per recipient, asset and amount until the owner votes on it, and asks for a repeat payout after the first is approved
or rejected; it never varies an amount or recipient to get past the rule. Offline-tested (`test/authorize.test.ts`,
`test/authorization.test.ts`) and stack-tested (`test/e2e/app-access.spec.mjs`).

**Following an operation to its end, without `recover`.** Every agent reconciles its own operations: every 10 seconds
it reads each unresolved operation's status once and records it (`startReconciliation`, `src/recover.ts`). It never
resends, and nothing an app calls is needed for that. An app follows that work through reads:
- `unresolved` lists the operations that block new sends, each with `key`, `kind`, `status`, `sent`, and the
  provider's recorded answer if any. An entry leaves the list when its outcome is proven.
- `activity` and `ledger` show settled operations.
- After a lost reply, an app reads the record that names the action, not a fresh send:
  - `proposals/get` for a proposal's execution
  - `payouts/status` by `requestId` for a payout (`payout` or `read` scope)
  - `owner/status` by `correlationId` for an owner action

  A payout request that reads `failed` (provider FAILED or REFUNDED) carries, from 0.5.5, `failureCode` (the provider's
  `failure_code`, from its status of that operation read when answering; null when that read fails or names none) and
  `neverExecuted`. `neverExecuted` is true only when the provider's status agrees with the journal's FAILED and carries
  `details.never_executed: true` with no `tx_hash`, `destination_tx_hash`, `refund_tx_hash`, `intent_hash`,
  `amount_out`, `refunded_amount` or `settled_late`. Per the provider's docs an owner's rejection of a held payout ends
  it so (skills `bedda21`, `references/owner-intents.md`: "`reject` ends it … (`FAILED`, `details.never_executed`)"),
  and its SDK names `never_executed` as the mark of an operation whose USD charge is released (`20ca15c`). It is the
  provider's statement, relayed: offline-tested (`test/payout-requests.test.ts`), not mainnet-observed. A rejection on
  staging read `FAILED` with code `rejected` (2026-10-30, [mainnet log](mainnet-log.md)); whether `never_executed` came
  with it wasn't recorded. False proves nothing either way: a delivery failure, REFUNDED, a missing flag or an unread
  status all read false, and a person checks before a new `requestId`. An expired approval reads true only if the
  provider marks it so; how it reports one is unobserved. Reading a `failed` request makes one provider status read;
  a `succeeded` one makes none.

  It never resends while that record reads `unknown`, `executing` or `processing`. The `recover` procedure isn't
  on app access and isn't needed: it runs the same pass the agent already runs every 10 seconds (platform#14). Poll only while a record is unresolved, and budget the deployment's polls as a whole:
  at the default 1,200 calls an hour, that's 20 a minute across all its agents and every other call. One poll a minute per open record
  fits about 15 agents with room for other calls; every 10 seconds fits only 3. On `rate_limited`, wait
  `retryAfterSeconds`.

The limit is per app credential, across every owner and Organization of the deployment: 1,200 requests an hour unless
the operator sets another, from 1 to 12,000, at issue (`--per-hour`) or later (`app-credential limit <id> <n>`, in place:
the token stays, and the gateway reads the new limit on the next call). A credential at the default stores no limit, so
its record is unchanged; one with a limit set can't be read by a gateway from before limits (0.5.3 and earlier), so before
rolling back to one, set each such credential back to 1,200. Over it,
the gateway answers 429 before forwarding anything, with `Retry-After` (delay-seconds until enough requests leave
the hour to bring the credential under its limit: the oldest one, unless the limit was just lowered) and `{ error, retryAfterSeconds }`. From SDK 0.5.2 `appClient` reports that as `kind: "rate_limited"` with
`retryAfterSeconds`, for its own routes and for agent calls alike, so it's never mistaken for a refusal or an unknown
outcome; the same request may be sent again once it clears. A 429 that isn't the gateway's JSON answer (a proxy page)
keeps its earlier kind: `refused` on the app routes, `unavailable` or `unknown` on agent calls.

From 0.5.7, calls on the path of an owner's or a DAO's signature with a short window draw on a second budget of the same
size, not the shared one: `POST /apps/v1/setup`, `/consents` and `/consent-nonces`, an agent's `owner/submit`, and the
DAO request reads that relay a passed vote's signature
(`GET /apps/v1/dao-{setups,consents,votes,hires}/<hash>`). The 0.5.8 order feature also puts
`limitOrders/approve`, `limitOrders/reject` and `GET /apps/v1/dao-limit-orders/<hash>` on that budget. Ordinary
traffic can't use it up and waste a signature, and those calls can't be used to get around the limit, since they count
against their own. A credential's busiest hour can therefore reach twice its limit. Each 429 adds a `rate_limited` line to the
access log with the deployment, the credential, which budget, and the Organization when the path names one; at most
one line a minute per credential and budget, so a flood can't grow the log (`test/app-access.test.ts`).

Also from 0.5.7, the shared budget keeps a slice for each Organization (#59, `src/gateway/fair-share.ts`). One
Organization alone may use all of it. Each other Organization seen in the hour, even one that was refused, keeps 5% of
the limit available until it has used that much, and a call is refused (`reason: "fair_share"` in the access log) if
serving it would eat into what is still owed to the others; the slices kept back never exceed half the limit. A call
whose path names an Organization (an agent call, a release) counts for it; one naming none counts toward the hour with
no slice. So a busy tenant can't starve an app's other tenants, and an app serving one Organization loses nothing. The
slice and its cap are fixed for now; an operator setting per Organization isn't built. Offline-tested
(`test/fair-share.test.ts`, `test/app-access.test.ts`, `test/contract-owner.test.ts`).

DAO requests are bounded per deployment: at most 64 waiting for a vote and 256 filed a day. A finished one (completed,
ended by a stop, lapsed with no signature found, or past what it signed) is removed 30 days later; the access log keeps
its history, and reading it after that answers 404. A signature found once is recorded and completes the request on a
later read until what the DAO signed expires (the consent's, setup's or proposal's `expiresAt`), never after.

Limits: DAO owners as above (Treasury only; no `payout` or `owner`); payout requests
pay confidential USDC through `intents`, or withdraw wNEAR (arriving as native NEAR) or USDC to an agreed NEAR account
(mainnet-observed on staging 2026-10-30), and a held withdrawal is approved like a transfer (offline- and stack-tested; its hash shape is mainnet-observed,
an approval isn't), with `destination_asset`, which the hash doesn't cover, required to be the token withdrawn, and no field outside the
set observed on mainnet; the owner can't revoke on the platform directly
(the deployment or the operator can, and removing the signing key ends it once a call or `check-keys` observes the
removal: a key removed and re-added with no call or sweep in between goes unnoticed); a wallet that signs a callback URL into
NEP-413 can't consent; owner actions are limited to the list above, and NEP-366 ones are signed on the platform's
confirm page; a withheld or unsigned intent stays open at the provider
until it expires, and an open policy intent blocks new agent creation until then (provider behavior, recorded in
`.agents/skills/near-agent-api`; whether it also delays other policy edits is not checked); hosted agents each have their own process (wallet-owned slot release shipped in 0.5.6, [release](agent-release.md)), so so setups (like self-service `/gw/agents`) can fill the host's 32-agent registry, each needing an
owner's signature; many Organizations need more hosts. Offline-tested (`test/app-access.test.ts`). On 2026-10-26 each of those checks (scope, agent identity,
host, deployment, owner, key permission, revocation, browser credentials) was also removed by hand and the tests failed
every time; that was a manual check, not part of the suite. Stack-tested with simulated provider, chain and wallet
(`test/e2e/app-access.spec.mjs`, run-rq8nqz, 2026-10-26): reads, owner actions, refusals, a withheld NEP-366 edit,
and hosted setup through creation and a grant; on 2026-10-27 (narrow run of that spec, Node 24.22.1) a NEP-366 policy
edit reached the app only as a confirm link and was signed by the simulated wallet on the platform's page in a
browser, and an owner's vote on a held payout was relayed by the app. Mainnet-observed on platform staging through the
platform's own stand-in app: the `read`, `owner` and `payout` scopes on a test agent
([2026-10-28](mainnet-log.md#app-access-on-platform-staging-2026-10-28-utc)) and payout withdrawals
([2026-10-30](mainnet-log.md#payout-withdrawals-on-platform-staging-2026-10-30-utc)). `treasury` and
`treasury-execute` are offline- and stack-tested only. No production host serves `/apps/v1`.


## Releasing an Organization agent (0.5.6 released)

After a wallet owner freezes and archives the agent, a live `owner` consent reaches
`POST /apps/v1/o/<organization>/a/<agent>/release`, exposed as `appClient(...).release(organization, agent, { allowBalance? })`.
A successful response is `state: "released"`; a checked refusal is `state: "refused"` with a reason and balances.
Other access failures retain the usual route result kinds. A retry finishes the same durable release, including after
its consents were revoked. Calls to a released identity or RPC answer 410 `agent_released` (a new `AppGatewayCode`;
**breaking for exhaustive switches**). Reservations expose the retained entry with `released: true`.
Restoration needs a fresh owner-signed setup with a platform-issued nonce; consents or setups signed before release
are refused under the existing `owner_stopped` code. The owner must separately sign fresh consent, unfreeze and restore.
See [the release contract and its evidence](agent-release.md). Wallet owners only; DAO release is unavailable.


DAO-owned app payouts (2026-11-12 candidate): a DAO may set up `area: "payables"`, then vote on
`agent_create` with `role: "payout"` under its setup consent. After creation, consent with `read` and
`payout` covers the existing app-scoped payout request/status flow and, on that Payables agent,
`owner/prepare` with `signer: "dao"` for a `payout` grant, revocation, policy edits, freeze/unfreeze
and `approval_vote`. The app receives the DAO proposal, never signing bytes; follow `owner/status`
until the agent finds and submits the signature. Approval verifies provider evidence again before
submission. `/dao-votes` remains for Treasury proposals. Vote success does not establish settlement;
follow `payouts/status` with the original request ID. `owner` remains unavailable in DAO consent.
Contract and gateway integration tests are in `test/app-dao.test.ts`; this candidate is not deployed
or mainnet-observed. Paperwork has adopted the pinned local artifact and passed local simulated acceptance;
its source remains in its separate repository, and hosted support is unverified. The existing policy controls whether payouts are held: apps must
review that `owner_approval` is enabled when promising a vote per payout.


Paperwork handoff for its owning session (checkout `/Users/jlwaugh/agencies/dao/demo`):

- Local package: `.test-artifacts/contract/multiagency-sdk-0.5.9.tgz` in the platform checkout;
  `pnpm contract:pack` writes its SHA-256 and provenance. This is a local package, not a published release.
- Update the app's pinned SDK while preserving its current dependency edits. Test against a platform
  snapshot containing the matching gateway changes; installing the SDK alone does not enable a host.
- Extend `src/server/platform/port.ts` and `client.ts`: the payout adapter currently forces wallet signing,
  requires an owner key on creation, and refuses replies with only `dao` as `unreadable_intent`.
  Preserve the selected signer and DAO proposal reply as the market adapter already does. DAO creation
  omits `owner` entirely and uses `role: "payout"`; the platform derives ownership from setup.
- Use `app.daoSetups.file` / `state` for the existing setup text with `area: "payables"`,
  then prepare creation under the returned temporary setup consent. Use `app.daoConsents.file` / `state`
  with the existing consent text carrying `read` and `payout`, omitting `owner`. Each is a DAO vote.
- Request `grant_issue`, `label: "payout"` with `signer: "dao"`. The app's stack adapter currently
  substitutes `invoices`; that substitution is wallet-only and is not admitted by this DAO contract.
- Keep app-scoped `payouts/request` and its durable job/request ID. Prepare `approval_vote` with the
  provider approval UUID, original payment correlation ID and exact verdict, `signer: "dao"`.
  Persist the returned owner-action correlation ID and proposal. Members file the returned DAO
  proposal; poll `owner/status`. Do not call `owner/submit` or sign the hash with a member's wallet key.
- Render the provider-verified `payment.terms` for review and preserve the immutable job comparison.
  Public DAO proposal wording stays generic for confidential payouts. A passed vote is followed by
  `payouts/status`; neither a proposal passing nor owner-action success proves payout settlement.
- Add app tests for DAO setup/consent recovery, creation without wallet ownership, payout grant,
  approve/reject, expired votes, restart after signature submission, and unchanged job/request identity
  after an unknown reply. Keep existing wallet coverage. Demonstrate with the simulated provider first.

The user retained Paperwork ownership in its other session on 2026-11-12. This platform change does
not edit that checkout. Deployment, SDK publication and live money actions remain the user's.


Release review (2026-11-12): the paired Paperwork local acceptance report identifies the same frozen
snapshot and SDK checksum as the platform manifest. Its reject/revise/approve, settlement and wallet
cases each record one successful simulated payment; its recovery case uses a clean database handoff
to another OS process. These are app-session observations with matching retained log hashes, not a
fresh rerun by the platform reviewer. The app's tested source manifest differs from its current tree
only in README and TASKS documentation. SIGKILL recovery, provider-response loss, hosted member-wallet
filing, actual quorum and mainnet settlement remain unverified.

Access-filing recovery limitation: `DaoRequests.file` chooses a fresh nonce for each setup or consent
filing. Retrying identical saved text after a lost reply can therefore leave another request/hash;
it does not recover the first identity. Paperwork's fixture checks reuse of the text, not gateway
idempotence. Once an ID is known, observe that ID; do not treat a replacement as proof that the first
request lapsed. Unobserved requests remain bounded by their vote and consent expiries. This is distinct
from payout-request and owner-signature recovery and does not establish another money send.
