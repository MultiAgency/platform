# Shared agent access contract

This is a local candidate in Proto, not a deployed service or mainnet observation. Proto owns the
credential store, host routing, owner consent and access management. Treasury supplies its planning
and execution handlers and its consuming skill. Installing a skill grants no authority.

## Owner access

`/a/<name>/access` is a shared workspace page. It loads `/gw/access-session`, a host-local signed-in
view of configured Treasury agents, independently of provider observations. Wallet owners match the
configured owner; DAO members need current onchain management permission to inspect or revoke existing
records. DAO members still cannot issue or use machine authority. That view
provides no signing or execution capabilities. It is not a fresh assertion of provider ownership.
On independently packaged product hosts, `/a/<name>/access` serves Proto's shared frontend;
content-hashed shared assets are available when absent from the product asset directory. Ordinary
product pages and existing product assets keep their own frontend. Host-local session checks and
payee routing remain unchanged.
The ordinary workspace still uses `/gw/me` and the existing dashboard authorization rules.

With the existing host-local owner session:

| Request | Result |
| --- | --- |
| `GET /gw/machine-credentials/<name>` | `{ credentials: [...] }`, metadata only, filtered to this host, configured owner and agent |
| `POST /gw/machine-credentials/<name>` | `{ credential, token }`, status 201; token returned once |
| `DELETE /gw/machine-credentials/<name>/<id>` | `{ revoked: true }`; repeated revocation is safe |

Issuance accepts `{ label, scopes, ttlSeconds }`. Labels are 1–80 trimmed characters; durations are
60–86400 seconds (default 3600); scopes are a nonempty, duplicate-free subset of `read`, `prepare`,
`execute-plan`, `sweep`. The UI defaults to read-only for one hour and requires a separate review.
The label is not proof of the calling agent's identity. Anyone holding the bearer secret can use it.

Management requires the signed-in account to equal the configured owner, or current DAO management
permission, and the agent to be assigned to the current host. Listing and revocation do not require a provider read. Issuance additionally
requires fresh chain evidence that the owner is not a DAO and a fresh provider-backed identity read
matching that owner. Missing, uncreated or replaced agents cannot acquire authority from a warmed
dashboard cache. A failed issuance ownership check returns 409; the UI keeps revocation reachable.
DAO members cannot delegate machine authority. No verified DAO approval mechanism is implemented.

Rotation creates a new credential through another explicit review, then revokes the old credential;
there is no renewal or automatic extension.

Lost issuance responses are ambiguous: inspect metadata, revoke inaccessible access, then explicitly
start another review. The UI does not retry issuance. Lost revocation responses are unconfirmed until
metadata is refreshed or revocation is retried. Secrets never enter query caches or browser storage.
Context changes and access denials clear private state and discard late responses. Copy failure keeps
the one-time field available for manual copy. Hiding or reloading cannot retrieve a secret again.

## Machine transport

Use `POST https://<issued-host>/machine/v1/a/<name>/rpc/<procedure>` with
`Authorization: Bearer <token>`, no cookies or Origin. The body and streamed responses use Proto's
pinned oRPC serialization (`@orpc/client` 2.0.0-beta.47, bundled in the SDK; beta.44 clients are tested offline only, see
[SDK changes](sdk-changes.md)). Unknown procedures refuse
access. Machine credentials are not browser sessions and cannot authenticate dashboard RPC or
credential-management requests. `ownerClient` from `@multiagency/sdk` reaches this route with an
absolute base and a `fetch` that adds the bearer (SDK skill `owner-workflows`); the client adds no
credential of its own.

| Scope | Procedures |
| --- | --- |
| `read` | `instance`, `overview`, `policyHistory`, `strategy/get`, `autopilot/get`, `activity`, `unresolved`, `autopilot/evidence`, `autopilot/log`, `ledger`, `ledgerCsv` |
| `prepare` | `externalPlan` (chosen swaps → saved plan); `rebalance` (allocation-based stream) |
| `execute-plan` | `executePlan` with `{ planId }` (stream) |
| `sweep` | `sweep` (existing input and streamed result) |

Permissions are independent: preparation does not permit execution; execution does not permit sweep;
execution does not imply reads. There are no owner-signing, policy/grant mutation, scheduling, recovery,
payments or payee procedures in this interface. The machine allowlist also intersects the current
dashboard capability mapping. Executor assignments remain enforced by the existing agent server.

Each credential binds the actual provider agent ID returned by `ownerIdentity`, configured agent
name, owner, issuing account and host. Each call rechecks fresh ownership, then expiry and revocation
after receiving the body and completing identity lookup. Authorization, cookies and client-supplied
`x-gateway*` headers are removed before forwarding. Admission attribution records the credential ID,
account, owner, host, agent ID and procedure, without request bodies or bearer secrets. Required record
or audit failures refuse forwarding. There is a 600-request hourly limit per credential.

Execution still uses the existing saved-plan claim, fresh checks, money lock, journal and dispatch.
A forwarded request may already have acted when its response is lost. Inspect the original plan and
operation records before another action. Revocation does not cancel a forwarded operation, stop the
schedule, or prove settlement. Credential status describes local expiry/revocation, not current
ownership, provider readiness, policy validity or settlement.

Credentials have **no separate spending budget**. External clients executing saved plans are not
limited by the scheduled autopilot's per-run ceiling. Existing policy and grant checks still apply.
Spending caps do not bound market exposure; provider concurrency guarantees remain unverified.

## Treasury skill/client contract

Use this single shared contract and the host/name supplied at consent. Never fall back to browser
cookies, another host, or the experimental Treasury gateway. Store the token in the runtime's secret
store, not a skill file or chat. Keep read, prepare, execute and sweep commands distinct. Consume
streams fully and execute only an explicitly selected saved plan. Do not retry unknown execution
outcomes automatically. Treat 401/403 as refused access and 404/405 as unavailable support.

The Treasury skill's `prepare FILE` calls `externalPlan` with a strict `{ swaps }` object: one to
eight ordered swaps between managed USDC, wNEAR and ETH, differing `from`/`to` asset IDs, positive
atomic-unit `amount` strings (at most 40 digits), and optional `minAmountOut`. Proto quotes each swap;
a supplied floor can tighten but never lower the provider floor. Invalid inputs, forbidden outputs,
excessive cost, aggregate overspending, changed policy/strategy/balances, or required storage failure
refuse the complete preparation. Preparation moves no funds and never drops or replaces chosen swaps.

The response is one saved plan with `source: external`, a UUID, five-minute expiry, exact ordered
actions and policy/strategy/agent bindings. `executePlan({ planId })` requires independent
`execute-plan` scope and runs the existing guarded dispatch path, including fresh quotes, plan claim,
lock, journal, unresolved-operation refusal and provider policy/grants. External choices need not
follow allocation targets, but retain the owner's strategy digest and cost limit. Credentials add no
spending budget; the scheduled autopilot's per-run ceiling does not limit external plan execution.

The Treasury-owned `skills/treasury` helper and documentation use this shared contract. The helper
checks returned chosen inputs and floors, reports unavailable support on 404/405, and never retries or
substitutes streamed `rebalance`. An older host without `externalPlan` remains unavailable for chosen
swaps. No separate gateway, consent, MCP or OAuth interface is introduced.

## Agent connections (contractor reports)

A user can connect an external agent to their workspace with an explicit, fixed set of permitted actions, and list
or revoke it. One mechanism serves every role, each with its own principal and permission sets
(`src/agent-connections.ts`, `src/contract/agent-connection.ts`). No connection carries every permission its user
has. Treasury's execution delegation (machine credentials, above) is a separate mechanism and stays so.

The first permitted set is a contractor's own compensation reports (`compensation.read`, `compensation.submit`) on
one payee entry:
- **Issuance:** `POST /api/agent-connections` on the entry, with the contractor's signed-in browser session only (any
  Authorization header → 403); the account is re-checked immediately before issuing. The `tac_<id>.<secret>`
  token is shown once and stored hashed. Lifetime is one minute to 24 hours. `GET` lists and `DELETE` revokes the
  account's own connections on that entry.
- **Binding:** host, entry (instance), account and payout agent id. Anything else is 401.
- **Reach:** with a bearer, the cookie is never read. Only `GET`/`POST /api/compensation` and
  `GET /api/compensation/session` answer; every other route is 403 and causes no business effect. Sign-in and
  session routes refuse it, so it never opens or becomes a browser session. A report write re-checks the
  connection immediately before acting.
- **Attribution:** each bearer call is appended to `.agent-connections/access.jsonl` (account, host, entry, agent,
  connection id, method, path, and command identity for writes).
- **Client:** `payeeClient({ base, token })` from `@multiagency/sdk/payee` sends the bearer
  without cookies, for programs outside a browser.
- **Consequence:** anyone holding the token can read the contractor's own reports and payment states, and submit
  reports as that contractor on that entry, until it expires or is revoked. It cannot file invoices or orders,
  approve, pay, or reach another account, entry or host.

Offline-tested (`test/agent-connections.test.ts`) and shown on the local stack (`agent-connection.spec.mjs`:
report, lost reply recovered by reading the same request id, owner review and authorization, human filing,
recorded payment, revocation; mutation challenge `agent-route-unrestricted`). Not deployed; no live credentials.

## App access (server to server)

An app deployment (for example the MultiAgency dashboard's `staging`) reaches agents under `/apps/v1` with its service
credential (`Authorization: Bearer
tap_<id>.<secret>`, no cookies or Origin). The operator issues it on the gateway host: `pnpm app-credential issue
<deployment> <host> [days]` (1–365 days, default 90; the token prints once), `list`, `revoke <id>`, and for consents
`consents [deployment]`, `revoke-consent <id>` and `check-keys` (checks every live consent's signing key and revokes those
the chain reports removed; exits non-zero if any lookup went unanswered).

| Request | Result |
| --- | --- |
| `GET /apps/v1/agents/<agent>` | `{ agent, owner, agentId, created, host, deployment }`: what the owner's consent must name (wallet-owned agents only; `agentId` null and `created` false before the agent exists) |
| `POST /apps/v1/setup` with a signed setup text | `201 { agent, consent }`: reserves and starts this owner's hosted agent for the area, and a setup consent (below) |
| `POST /apps/v1/consents` with `{ message, nonce, publicKey, signature }` | `201 { consent }`; responses omit the message, nonce and signature, which the record keeps (mode 0600) |
| `GET /apps/v1/consents[?organization=]` | This deployment's consents on this host |
| `DELETE /apps/v1/consents/<id>` | `{ revoked: true }`; this deployment's on this host only; permanent (below) |
| `POST /apps/v1/o/<organization>/a/<agent>/rpc/<procedure>` | Forwarded to the agent with actor `app:<deployment>:<organization>` |

The consent text is exactly `consentMessage({ host, deployment, organization, owner, agent, agentId, scopes, expiresAt })`
(`src/contract/app-consent.ts`), signed with NEP-413 for recipient the host, with a 32-byte nonce and no callback URL.
It is refused unless it names this host and the calling deployment, expires between a minute and 366 days from now,
verifies, and the key is a full-access key of the owner now. The agent must be configured with that owner, and the owner
must be a wallet whose agent's server reports that owner and the provider agent ID the text names (the machine route's
check), so a signature held for an agent that was since replaced isn't attached to the replacement.

**Setup.** The owner signs `setupMessage({ host, deployment, organization, owner, area, expiresAt })` (at most an hour;
the same checks as a consent). Wallet owners only: a DAO owner gets 409. The platform then reserves the hosted agent for
that owner and area, under the same rules as self-service `/gw/agents` (self-service enabled, the area allowed on this
host, registry capacity), starts it, and stores a setup consent: `owner` scope with the reserved stand-in agent ID
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
policy). Scopes are separate: a consent carries each it needs. Agreements, invoices, compensation and work-order records are not
reachable. Each
consent, call and revocation is appended to `.app-access/access.jsonl`.

Limits: wallet owners only (DAO consent and DAO setup are not available, and `signer: "dao"` is refused); payout requests
pay confidential USDC through `intents`, or withdraw wNEAR (arriving as native NEAR) or USDC to an agreed NEAR account
(not mainnet-observed), and a held withdrawal can only be rejected (approving one isn't available until its approval is
verified); the owner can't revoke on the platform directly
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
browser, and an owner's vote on a held payout was relayed by the app. Not deployed; no live credentials.

## State preservation and rollback

`.machine-auth/` is additive host-local gateway state, owned by one gateway process. It contains
private version-2 JSON records (SHA-256 secret hashes, mode 0600, directory 0700) and admission audit
records. Existing version-1 experimental records remain listable and revocable but cannot authenticate;
there is no automatic authority upgrade. The directory is excluded from Git and both Docker contexts.

`.agent-connections/` is additive per-entry state in each payee entry's executor directory: private records
(SHA-256 secret hashes, mode 0600, directory 0700) and `access.jsonl`. No conversion is needed. Losing it ends every
agent connection on that entry (tokens are refused) and loses their attribution; restoring an older copy can
restore revoked connections, so preserve the latest. Preserve `.machine-auth/` alongside `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`,
`.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/`, and `.hosted/`. No conversion of
existing records is required. External plans add the `external` source value to new `.plans/` records;
existing plans, claims and all other state remain unchanged and use the same loader/executor.
Do not copy credentials between hosts or executors. Backups and restores
must preserve current revocations: restoring an older credential directory can restore revoked
authority. A code rollback must retain the latest directory; if that cannot be guaranteed, disable
machine routing until credentials have been explicitly revoked or expired. Distributed revocation or
fencing is not implemented. No deployment, production restart or live action is part of this change.

## Local acceptance

- `test/machine-auth.test.ts`: persistence, secret hashing, expiry, revocation, legacy refusal and scopes.
- `test/machine-authority.test.ts`: fresh evidence despite a warm dashboard cache; missing identity refusal.
- `test/machine-routes.test.ts`: scope and identity binding, body/lookup revocation race, sanitized forwarding,
  provider-outage management, and refusal on audit-storage failure.
- `test/machine-hosts.test.ts`: real shared gateway host/session/agent isolation and DAO refusal.
- `test/browser/agent-access.cjs`: desktop/light and mobile/dark, defaults, explicit review, focus,
  copy failure, one-time secrets, ambiguous outcomes, denial redaction and late issuance after navigation.
- `test/e2e/agent-access.spec.mjs`: real shared gateway and executor with a simulated provider and wallet;
  consent, exact chosen-swap preparation/execution with autopilot ceiling zero, duplicate refusal and
  provider-outage revocation after reload. With `--treasury-skill PATH`, uses the actual snapshotted helper.
- `test/external-plan.test.ts`: input validation, ordered choices/floors, whole-plan rejection, policy and
  balance races, stale valuation and storage failure without sends.
- `test/e2e/treasury-client.spec.mjs`: actual helper rejects changed/empty preparation, unavailable support
  and transport failure, without retry/fallback or secret/error-detail leakage.
- `test/e2e/treasury-interruption.spec.mjs`: real helper child process, shared gateway/executor and
  simulated provider. Losing either the first swap response or the second after a confirmed first
  success leaves one unresolved operation and blocks replay and
  replacement sends. Killing the helper after its first success does not duplicate submissions;
  the admitted server execution can continue after the client dies. Client disconnection is not
  cancellation, and absence of a client receipt is not proof that nothing moved.

Reproduce the consumer flow with `node test/e2e/run.mjs --treasury-skill
/absolute/path/to/treasury/skills/treasury agent-access.spec.mjs treasury-client.spec.mjs treasury-interruption.spec.mjs` (one shell
command). The manifest records the consumer snapshot hash; ordinary runs do not assume a sibling checkout.

These tests do not establish live provider behavior, distributed safety, screen-reader usability with
assistive hardware, or real-provider crash/settlement behavior. Client crash and response-loss cases
are simulated-provider acceptance only; executor/host termination at every dispatch boundary is not
established by these consumer tests. Existing mainnet claims and generated evidence tables are unchanged.

## Release review (not deployed)

1. Review the Proto and Treasury skill/client diffs together, preserving other sessions' edits.
   Retain the acceptance manifest and its exact source, client and dependency hashes.
2. Before a user-controlled release, confirm executor assignments and host registries and preserve
   all state listed above, especially current credential revocations and plan execution claims.
3. Release compatible gateway and agent procedures together. An older agent without `externalPlan`
   must remain unavailable for chosen swaps; no rebalance or experimental-gateway fallback is allowed.
4. After the user's deployment, begin with read-only checks. Live credential issuance, owner signing
   and funded execution require separate explicit authorization.
5. On rollback, preserve current state and never restore old revocations or unclaimed copies of
   executed plans. If compatible state cannot be retained, disable machine routing until addressed.
   A rollback or disconnected client does not cancel an admitted operation: inspect its journal and
   unresolved outcomes before any subsequent money action.
