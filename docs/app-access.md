# App access

How an app's server reaches agents under `/apps/v1` with its service credential and each owner's signed consent: the
routes, consent and setup, what each scope permits, how owner actions reach the owner (NEP-413 in the app, NEP-366 on
the platform's confirm page), what a dishonest app can still do, and how each part is known. Builders start with
[building an app](integration-path.md) and the SDK's `app-server` and `treasury-app` skills; this page is the platform
side.

The platform's own host (`api.dev.multiagency.ai` for staging; `api.multiagency.ai` later) runs the `platform` package
headless: only `/health`, these routes and the confirm page with its own assets, and app setup for Payables agents only
(`deploy/platform*.json`; offline-tested in `test/platform-host.test.ts`, E2E on a headless stack). Staging has run it
since 2026-10-31 (read-only checks in [platform staging](platform-staging.md)); no production
host yet. The prototype's hosts (the `dao` package) serve these routes beside their owner app.

An app deployment (for example the MultiAgency dashboard's `staging`) reaches agents under `/apps/v1` with its service
credential (`Authorization: Bearer
tap_<id>.<secret>`, no cookies or Origin). The operator issues it on the gateway host: `pnpm app-credential issue
<deployment> <host> [days]` (1–365 days, default 90; the token prints once), `list`, `revoke <id>`, and for consents
`consents [deployment]`, `revoke-consent <id>` and `check-keys` (checks every live consent's signing key and revokes those
the chain reports removed; exits non-zero if any lookup went unanswered).

| Request | Result |
| --- | --- |
| `GET /apps/v1/agents/<agent>` | `{ agent, owner, agentId, created, host, deployment, signer }`: what the owner's consent must name (`signer` is `wallet` or `dao`; `agentId` null and `created` false before the agent exists) |
| `POST /apps/v1/setup` with a signed setup text | `201 { agent, consent }`: reserves and starts this owner's hosted agent for the area, and a setup consent (below) |
| `POST /apps/v1/consents` with `{ message, nonce, publicKey, signature }` | `201 { consent }`; responses omit the message, nonce and signature, which the record keeps (mode 0600) |
| `GET /apps/v1/consents[?organization=]` | This deployment's consents on this host |
| `DELETE /apps/v1/consents/<id>` | `{ revoked: true }`; this deployment's on this host only; permanent (below) |
| `POST /apps/v1/o/<organization>/a/<agent>/rpc/<procedure>` | Forwarded to the agent with actor `app:<deployment>:<organization>` |
| `POST /apps/v1/dao-setups`, `/dao-consents` with `{ message }`; `/dao-votes` with `{ organization, agent, proposal, verdict }` | `201 { request, transactions }`: the DAO's proposal for a member to file (`proposal`, or `proposalAndVote`) |
| `GET /confirm/dao/<hash>` (public, no credential) | The voter check page: the request's exact text, nonce and host, and whether its hash recomputes; plain HTML, no script |
| `GET /apps/v1/dao-setups/<hash>`, `/dao-consents/<hash>`, `/dao-votes/<hash>` | `pending` until the DAO's signature is found; then `reserved`, `signed` or `relayed` (410 once its vote window closed) |

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
The owner then signs an ordinary consent naming the new provider ID. An app's setup reserves that deployment and
Organization's own agent, per owner and area (`.hosted/apps.json` records the scope), so Organizations sharing an
owner wallet don't share payees, budget or balance: each policy is signed and provider-enforced. Only that deployment
reads its identity, and only that deployment for that Organization stores consents for it and calls it, whatever consent
is signed, since a consent names the agent by a generated name its owner can't tell apart. The scope names the
deployment, not the host: give each app deployment a distinct name on every host. One deployment holds at most 16
Organization agents per host (`PER_DEPLOYMENT`), so it can't take the host's capacity. Self-service setups
(`/gw/agents`) stay per owner and area. An ownership or key check that goes unanswered (the agent's server, a chain
read) is 503 on every app route: nothing is stored or forwarded, and the app reads again or resends the same body;
refusals (400, 403, 404, 409) are answers.

A revocation writes a tombstone, `.app-access/revoked/<id>`, which is never deleted: a revoked consent stays
revoked even if its record is archived, and its signature can't be stored again. The operator can revoke any consent by
id, including one whose record is already gone. Expired records may be archived; their text can't verify again. Each
deployment holds at most 1,024 unexpired consents.

A call is forwarded only with a live consent for that deployment, host, Organization and agent, bound to the agent's
current provider ID, whose signing key is still a full-access key of the owner, and whose scope allows the procedure. The
key is read with `view_access_key` at final finality on every call (`chainKeyState`, `src/signin.ts`): when the chain
answers that the key is absent or no longer full-access, the consent is revoked for good (tombstone reason `key-removed`
or `key-not-full-access`), so re-adding the key revives nothing; an unanswered lookup refuses the call with 503 and
revokes nothing. Read scope: `read` permits `instance`, `overview`, `policyHistory`,
`activity`, `unresolved`, `held`, `ledger`, `ledgerCsv`, `owner/actions`, `owner/pending`, `owner/status`,
`paymentHistory` and `paymentStatus`. Owner scope: `owner` permits `owner/prepare`, `owner/submit`, `owner/status`,
`owner/pending` and `owner/actions`, and nothing else (no reads beyond those). Payout scope: `payout` permits
`payouts/request`, `payouts/status`, `held` and `deposit` (a one-time address crediting USDC to the agent's
confidential balance, so the app can fund it; it moves nothing out): payout requests (CONTEXT.md, "Payout request"), each sent at most once
under the app's `requestId` and namespaced by the actor `app:<deployment>:<organization>`, judged as a payout
(`authorize`, then the provider's policy) and refused before sending on an agent whose grant is for other work. The
`held` read shows every held payout of the agent, not only this app's. With `owner_approval: false` an app with `payout` consent pays agreed payees
within caps and budget with no owner signature; that bound is the owner-signed policy. `owner/prepare` must name `signer: "wallet"`:
the owner signs in the app with their own wallet, and `owner/submit` verifies that signature against the prepared
intent (`src/owner-signature.ts`), so the app can prepare and forward but never complete an owner action alone.
**The app chooses what it asks for, never what the owner reads** (`appMayAsk`, `src/contract/app-access.ts`;
`appMayPrepare` and the reply hold in `src/gateway/app-routes.ts`). The app may prepare `agent_create` without payees (the
policy is the platform's treasury or payout policy; the owner key must be the one that signed the setup),
`agent_freeze`, `agent_unfreeze`, `grant_issue`, `grant_revoke`, `policy_update` of any field, and `approval_vote`. The
gateway reads each prepared reply before releasing it:
- NEP-413 goes to the app unchanged: it is a text the owner's wallet can show (which wallets show it is not checked).
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
  proven terms (`payment`) for the app to show. What a dishonest app gains: a vote on another of this agent's held
  payouts than the one it showed, which is itself a transfer to an agreed payee within the caps; the power it would
  have if the owner had turned `owner_approval` off. The vote's signed text names no payee or amount: it is OutLayer's
  `approve:{approval_id}:{wallet_pubkey}:{request_hash}` (recorded 2026-10-11 on a payout agent,
  `.agents/skills/near-agent-api`). So the owner sees the terms only where the app shows `payment.terms`, and can't
  catch that swap in the wallet.
- Refused before forwarding: `signer: "dao"`, `agent_create` with payees, other owner actions (such as
  `agent_delete`), and anything that doesn't parse as the agent server would read it (oRPC's `RPCSerializer`, then
  `ownerPrepareInput`).

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
[enforcement](enforcement.md#treasury-proposals-offline--and-stack-tested)), autopilot on and off, sweep and proposals:
its swaps run only after the owner signs each proposal's exact terms (`proposalText`), a check the platform makes, not
the provider. With `treasury-execute` as well, it can prepare and execute plans within the policy and the strategy's
cost limit without a signature per swap, only while the owner's live grant binds the plan's strategy
([enforcement](enforcement.md#treasury-proposals-offline--and-stack-tested)). Scopes are separate: a consent carries each it needs. Agreements, invoices, compensation and work-order records are not
reachable. Each
consent, call and revocation is appended to `.app-access/access.jsonl`.

DAO owners: a DAO's consent is signed by its own vote (`POST /apps/v1/dao-consents`, then `GET /apps/v1/dao-consents/<hash>`
until the DAO's signature is found; coordination/p5-treasury-dao-consent.md). It carries only `read`, `treasury` and,
as the DAO's opt-in, `treasury-execute`, and each call re-reads that the agent is still owned by the DAO's derived
account. The DAO's grant vote is what authorizes unattended swaps (autopilot, and with `treasury-execute` the app's
plans), within the strategy it binds and the DAO's signed policy; the grant's proposal says so. The platform authorizes the app, not a member: the app gates its own members with the
SDK's `accessOf` and `mayCall`, from the DAO's policy. Under it the app asks for the DAO's
votes: on its Treasury proposals (`POST /apps/v1/dao-votes`, relayed to the agent once the signature is found), and on
the `treasury` grant, freeze and unfreeze (`owner/prepare` with `signer: "dao"`, which answers the proposal to file;
the agent submits the signature). A DAO sets up a hosted Treasury agent by vote too (`POST /apps/v1/dao-setups`,
then `agent_create` with `signer: "dao"` under its setup consent, a second vote within the intent's minutes). A
host that doesn't set up Treasury agents refuses it before filing anything, so no vote is spent on it.
**A DAO's own stop, with no app:** anyone opens `/confirm/dao/stop/<agent>`. The page files a stop the DAO votes on, or
shows the one already open, with the exact text, its hash, and the proposal to file (Trezu's custom function call, or the
whole transaction). Once the vote has passed, opening the page again revokes every consent naming the agent ID, from
every app, and turns the agent's autopilot off. It only removes authority. Offline- and stack-tested (simulated DAO votes); no host serves it yet. See
[enforcement](enforcement.md#dao-owners-through-apps-offline--and-stack-tested).

Limits: DAO owners as above (Treasury only; no `payout` or `owner`); payout requests
pay confidential USDC through `intents`, or withdraw wNEAR (arriving as native NEAR) or USDC to an agreed NEAR account
(mainnet-observed on staging 2026-10-30), and a held withdrawal can only be rejected (approving one isn't built yet,
though its approval's hash is now observed); the owner can't revoke on the platform directly
(the deployment or the operator can, and removing the signing key ends it once a call or `check-keys` observes the
removal: a key removed and re-added with no call or sweep in between goes unnoticed); a wallet that signs a callback URL into
NEP-413 can't consent; owner actions are limited to the list above, and NEP-366 ones are signed on the platform's
confirm page; a withheld or unsigned intent stays open at the provider
until it expires, and an open policy intent blocks new agent creation until then (provider behavior, recorded in
`.agents/skills/near-agent-api`; whether it also delays other policy edits is not checked); hosted agents are never released, and
each is its own process, so setups (like self-service `/gw/agents`) can fill the host's 32-agent registry, each needing an
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
