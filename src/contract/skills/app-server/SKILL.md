---
name: app-server
description: >
  Use when building an app's server (for example the MultiAgency dashboard's) that reaches MultiAgency agents for its
  Organizations through @multiagency/sdk: the deployment's service credential, owner consents and hosted setup signed
  with the owner's wallet or a DAO's vote, reads and the owner actions an app may relay, and payout requests sent at
  most once per requestId and followed by status. Server side only; never in a browser. Not for an owner's own browser app (use
  owner-workflows) or payees (use payee-workflows).
metadata:
  purpose: 'An app server''s access to agents: credential, consents, relayed owner actions, and payout requests by requestId with recovery by state.'
  type: core
  library: '@multiagency/sdk'
  library_version: '0.5.8'
requires:
  - getting-started
  - owner-workflows
sources:
  - 'MultiAgency/platform:src/contract/app-client.ts'
  - 'MultiAgency/platform:src/contract/app-access.ts'
  - 'MultiAgency/platform:src/contract/app-consent.ts'
  - 'MultiAgency/platform:src/contract/dao-roles.ts'
  - 'MultiAgency/platform:src/testing/payout-double.ts'
  - 'MultiAgency/platform:docs/app-access.md'
---

# An app's server with appClient

Read getting-started and owner-workflows first. `appClient` runs on your server with the deployment's service credential
(`tap_…`), issued by the platform operator: a server secret, never sent to a browser. A call reaches an agent only
under a live owner consent for that Organization and agent, and only within the consent's scopes: `read`, `owner`,
`payout`, and for Treasury `treasury`, `treasury-execute` and the separate `treasury-orders` (see treasury-app).
The staging and production platform API hosts are headless: use `/apps/v1` and the confirm page, not owner sign-in
or `/gw/me`. The checked-in staging config permits setup for Treasury, Payables and market agents; production
currently permits Payables only. Build and test with the SDK repository's local stack
(`pnpm test:e2e:stack --app <deployment>`). `app.capabilities()` reads the authenticated host's advertised app
routes; a capability grants neither owner consent nor provider support.

The local stack serves HTTPS with its own self-signed certificate, written to `<stack dir>/environment/localhost.crt`
(the stack prints `<stack dir>/state.json` when ready). Trust that certificate only, never turn verification off. In
Node, start your server with `NODE_EXTRA_CA_CERTS=<stack dir>/environment/localhost.crt`, as the platform's own
end-to-end tests do. In Bun, pass `appClient` a `fetch` that adds Bun's `tls.ca` option:
`fetch: (input, init) => fetch(input, { ...init, tls: { ca: caPem } })`, where `caPem` is that file's text. Covenant
runs on the stack this way.

## Setup

```ts
import { appClient } from "@multiagency/sdk";

// `platform` is the platform host's HTTPS origin; `credential` comes from your server's secret store.
export const platformFor = (platform: `https://${string}`, credential: string) => appClient({ base: platform, credential });
```

Result: `await app.identity("payout")` answers `{ ok: true, value: { agent, owner, agentId, created, host, deployment, signer } }`.
`signer` is `wallet` or `dao`: for a DAO-owned agent, follow "A DAO owner" below instead of the wallet sections.
`session` (401) means the credential is invalid, expired or revoked: an operator matter, not the user's.

## Connect an Organization's agent: the owner signs a consent

Your server builds the exact consent text and asks the platform for a 32-byte nonce (`consents.nonce()`); the owner's
wallet signs the text with that nonce using NEP-413, recipient the platform host, no callback URL; your server submits
it. Show the owner the text the wallet signs. A platform nonce shows the text was signed after any wallet stop the owner
signed earlier: after one, a text signed with a nonce your server picked is refused.

```ts
import { appClient, consentMessage, type AppConsentSubmission } from "@multiagency/sdk";

type SignNep413 = (message: string, recipient: string, nonce: Uint8Array) => Promise<{ publicKey: string; signature: string }>;

export async function connect(app: ReturnType<typeof appClient>, host: string, deployment: string, organization: string,
  agent: string, sign: SignNep413) {
  const identity = await app.identity(agent);
  if (!identity.ok) return identity;
  if (!identity.value.agentId) throw new Error("Not created yet: set it up and create it first");
  const message = consentMessage({ host, deployment, organization, owner: identity.value.owner, agent, agentId: identity.value.agentId,
    scopes: ["read", "owner"], expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
  const issued = await app.consents.nonce();
  if (!issued.ok) return issued;
  const signed = await sign(message, host, Uint8Array.from(atob(issued.value.nonce), c => c.charCodeAt(0)));
  const submission: AppConsentSubmission = { message, nonce: issued.value.nonce, ...signed };
  let stored = await app.consents.submit(submission);
  // No answer: the same signed body is safe to submit again; never ask the owner to sign again for that.
  if (!stored.ok && stored.kind === "unavailable") stored = await app.consents.submit(submission);
  return stored;
}
```

Result: `{ ok: true, value: { consent: { id, scopes, expiresAt, … } } }`; keep `consent.id` with the Organization. Decide
by `code` (`APP_GATEWAY_CODES`), not status: `signature_invalid` or `invalid_request` means the text or signature was not
accepted; `agent_changed`, `owner_changed` or `not_created` means the agent isn't the one the text names: read
`identity` again and ask the owner to sign a new text. `owner_stopped` means the owner's wallet stop covers the agent
and the text's nonce wasn't issued by the platform after it: ask for a new nonce and a new signature. Later agent calls answer `forbidden` once the consent ends, with
`code` `no_consent` (expired or revoked), `consent_revoked` (the owner's signing key removed) or `agent_changed` (the
agent was replaced): the owner signs a new one. `scope` means no consent covers that procedure. `unavailable` (503: a
check went unanswered) means send the same request again.

## Relay an owner action

With `owner` scope an app may prepare `agent_create` without payees (naming the key that signed the setup),
`agent_freeze`, `agent_unfreeze`, `agent_archive`, `agent_restore` (0.5.6), `grant_issue`, `grant_revoke`, `policy_update`, and
`approval_vote` on a held payout, through `app.agent(organization, agent).call(...)`. Everything else is refused before it reaches the agent. A vote the
platform can't verify (an expired or changed approval, other terms, a withdrawal approval naming unobserved fields) is refused before
anything reaches the provider (`refused`, code `local_authorization_held`), at prepare or at submit.

To bind a grant to an end date (a contract's end, say), send `grant_issue` with `expiresAt` (ISO timestamp): at least
an hour and at most 365 days ahead, the provider's maximum (`MIN_GRANT_MS`, `MAX_GRANT_MS`), refused outside that range, never clamped; with no
`expiresAt` the grant lasts 30 days. Show the owner `grant.expiresAt` from the prepared answer (the top-level `expiresAt`
is the signing window). Per the provider's docs the expired grant then authorizes no new sends; not observed on
mainnet. A longer engagement needs a new grant before the old one ends, and a new grant doesn't end earlier ones:
revoke those to end their authority.

```ts
import { appClient, type AppOwnerAction } from "@multiagency/sdk";

type SignNep413Intent = (intent: { standard: "nep413"; payload: { message: string; recipient: string; nonce: string } }) => Promise<Record<string, unknown>>;

/** Prepares an owner action; a readable one the owner signs in your app, any other on the platform's confirm page. */
export async function ownerAction(app: ReturnType<typeof appClient>, organization: string, agent: string, action: AppOwnerAction,
  signReadable: SignNep413Intent, openForOwner: (url: string) => void) {
  const calls = app.agent(organization, agent);
  const prepared = await calls.call("owner/prepare", { action, signer: "wallet" });
  if (!prepared.ok) return prepared;
  const { correlationId, intent, confirm } = prepared.value;
  if (confirm) openForOwner(confirm.url); // NEP-366, or a vote on a held payout: the owner reads the platform's record and signs there
  else if (intent?.standard === "nep413")
    await calls.call("owner/submit", { correlationId, signedData: await signReadable(intent) });
  return calls.call("owner/status", { correlationId });
}
```

Result: `owner/status` answers the outcome; read it again until it is final. Open a `confirm` link for the owner right
away (the intent expires in minutes). It shows the action's terms to whoever holds it; the bytes to sign go only to
whoever presents the owner's signature over the link's text, which the page asks the wallet for, and `owner/submit`
through the app is refused for it. A vote's link is the exception: you hold its text too, so the page signs it
directly and you may still submit it.

To stop quickly:
- If you turned autopilot on (treasury-app), call `autopilot/stop` first. Revoking your consent doesn't stop it: the
  schedule runs under the owner's grant, and once you revoke you can't reach the agent to stop it.
- Revoke your consent: `app.consents.revoke(consent.id)` needs no wallet signature and refuses your later calls under
  that consent (another live consent of yours for the agent stays live). It is permanent: to resume, the owner signs a
  new consent. It doesn't cancel a call already forwarded.
- Relay `agent_freeze` for the owner: it opens the confirm page, and the owner must sign there before the link expires
  (minutes). `agent_unfreeze` releases it the same way; `approval_vote` is only for held payouts.
- A wallet owner can also stop and freeze without you, on the platform's page `https://<host>/confirm/wallet/stop/<agent>`
  (platform 0.5.5): it ends every app's consent for the agent and, if the owner ticks the freeze, has their wallet sign
  the provider's freeze there. Link to it rather than building your own; unfreezing is still yours to relay.
- Treat anything `executing`, `processing` or `unknown` as possibly sent: neither step undoes it. Whether a freeze or a
  revoked grant stops a payout the provider already holds is not established
  ([enforcement](https://github.com/MultiAgency/platform/blob/main/docs/enforcement.md)).

A vote on a held payout names it from `held` (`approvalId`, `correlationId`). The prepared vote's `payment.terms`
(recipient, asset, amount) are what the platform proved against the provider's evidence: show those to the owner, not
your own record of the request. The vote's signed text holds only an identifier and a hash, so the wallet can't show
the terms. The prepared vote also carries `confirm.url`: the platform's page showing those proven terms, where the owner
signs with their own wallet. Prefer sending the owner there; the platform submits from it, and you follow the outcome
with `owner/status`. You also get `intent` and may have the owner sign it in your app as before. A payout an owner
approves can still read `processing` until the provider settles it; follow `payouts/status`.

An approve's `payment.repeats` lists this agent's payouts of the same payee, asset and amount in the last 24 hours
(`{ checked: true, payouts: [{ correlationId, at, status }] }`), or `{ checked: false }` when the provider's history
couldn't be read in full (0.5.8). Show it beside the terms: a second payment of one invoice under a new `requestId`
looks like any new payout, and this is where the owner sees the first. It refuses nothing; a recurring payment repeats
too. The confirm page shows it as well.

## Set up a hosted agent for an Organization

Before an Organization has an agent, your server builds `setupMessage({ host, deployment, organization, owner, area,
expiresAt })` (at most an hour ahead) and the owner signs it like a consent; submit it with `app.setup(...)`. The answer
names the Organization's own agent and a setup consent that lets you relay only its creation: `agent_create` without
payees, naming the key that signed the setup. Then read `identity` until it is created, and ask the owner to sign a
consent naming its `agentId`. `already_created` means it already exists (ask for a consent); `setup_failed` says why
it couldn't be set up (for example the deployment's agent limit on the host); `unavailable` means a check went
unanswered: submit the same body again.

**Lost setup reply.** Until the setup's `expiresAt`, submit the same signed body again: it answers the same agent and
the same setup consent, and reserves nothing new. After it expires the platform refuses the body; ask
`app.reservations({ organization, owner, area })` instead, which lists the agents your deployment's setups reserved for
that Organization (only yours, nothing reserved or signed). It also names the agent after `already_created`. Then read
`identity`: if the agent isn't created yet, the owner signs a new setup, which finds the same agent. A platform before
0.5.5 answers `refused` 404.

## A DAO owner: every signature is the DAO's vote

When `identity` answers `signer: "dao"`, the owner is a Sputnik DAO and has no keys. Each signature is a proposal its
members pass. The platform builds every text and files the request; your app gets the proposal a member's wallet signs
(`proposal`, or `proposalAndVote` to file and vote in one transaction), never a text to sign. Show the member the
proposal's `description` and the check link in it (`https://<host>/confirm/dao/<hash>`), which shows the exact text and
its hash recomputed.

```ts
import { appClient, consentMessage } from "@multiagency/sdk";

type MemberSigns = (transaction: { receiverId: string; actions: readonly unknown[] }) => Promise<void>;

/**
 * A DAO's consent: a member files the proposal (and votes in the same transaction if their role may vote: otherwise
 * the DAO refuses the whole transaction); the consent is stored when you read its state after the vote passed.
 */
export async function daoConsent(app: ReturnType<typeof appClient>, host: string, deployment: string, organization: string,
  agent: string, memberSigns: MemberSigns, memberVotes: boolean) {
  const identity = await app.identity(agent);
  if (!identity.ok) return identity;
  if (identity.value.signer !== "dao" || !identity.value.agentId) throw new Error("Not a created DAO-owned agent");
  const filed = await app.daoConsents.file(consentMessage({ host, deployment, organization, owner: identity.value.owner, agent,
    agentId: identity.value.agentId, scopes: ["read", "treasury"], expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() }));
  if (!filed.ok) return filed;
  const { proposal, proposalAndVote } = filed.value.transactions;
  const transaction = memberVotes && proposalAndVote ? proposalAndVote : proposal;
  if (transaction) await memberSigns(transaction);
  // `pending` until the DAO's vote passes: read again later with the same id; never file again for that.
  return app.daoConsents.state(filed.value.request.id);
}
```

Result: `state` answers `pending`, then `signed` with the consent (`signer: "dao"`). Nothing watches for the vote:
reading `state` after it passed is what finds the DAO's signature and stores the consent, so keep reading until it's
final (for a vote, `state` is also what relays it). 410 means the vote didn't pass before `votingUntil`: file again
for a new vote. `proposalAndVote` is null when the DAO's next proposal id couldn't be read; file `proposal` then. The
same shape covers the rest:
- **Setup:** `app.daoSetups.file(setupMessage({ … owner: dao, area: "treasury", … }))`, at most 7 days ahead, Treasury
  only, and only on a host whose setup includes Treasury (the deployed platform host's doesn't yet: 403). `state` answers `reserved` with the agent and a setup consent. Then `owner/prepare` with
  `{ type: "agent_create", role: "treasury" }` and `signer: "dao"`. Then file the DAO's consent naming the new `agentId`.
- **Owner actions:** under a `treasury` consent, `owner/prepare` with `signer: "dao"` prepares the `treasury` grant,
  `grant_revoke`, a `policy_update`, freeze or unfreeze. The grant may name `expiresAt`, as above; its proposal names
  the grant's expiry apart from the signing window. A policy edit's public proposal names only the fields it
  changes: show members `policy.current` and `policy.requested` from the answer before they vote. For an on-chain edit
  (actions, assets, limits, approval, `max_actions_per_hour`; 600 s) the bytes carry the policy encrypted, so members
  rely on that preview, as a wallet owner does.
- **A `policy_update`'s `limits` replaces the policy's limits whole** (any owner): send every period and asset you mean
  to keep, starting from `overview`'s `policy.policy.limits`. `{ limits: { hourly } }` alone drops the per-transaction,
  daily and monthly limits. The other fields (`budget`, `assets`, …) are replaced whole too. A member files the answer's `dao.proposal` (or `dao.proposalAndVote`); `dao.transaction` is the
  `v1.signer` call inside that proposal, never one a member signs. The agent finds and submits the DAO's signature
  itself once the vote passes; follow `owner/status`.
- **Treasury proposals:** see treasury-app.

Scopes: `read`, `treasury`, and `treasury-execute` if the DAO votes it in. Not `owner` or `payout`. Consent and
proposal votes may take the DAO's voting period (at most 7 days). Creation, the grant, its revocation, policy edits, freeze and unfreeze are provider
intents with fixed windows, 600 s for wallet requests (creation, freeze, unfreeze, on-chain policy edits) and about 290 s for consent messages (the grant, a revocation, off-chain policy edits), per the provider's docs (owner-signing, signing-standards, read 2026-11-05); nothing lengthens them. They complete only for a DAO whose vote passes that fast:
show `expiresAt`. A slower DAO can still approve each swap as a Treasury proposal (treasury-app), but can't issue the
strategy grant that unattended swaps (autopilot) need (#20). A
signature found once completes on a later read until what the DAO signed expires, never after (410). A DAO can also stop
its agent without you: a stop it votes on (`https://<host>/confirm/dao/stop/<dao>/<agent>`) revokes every app's consent
for the agent given before the stop applies, ends consent requests filed by then (their `state` answers 409, whatever
their vote), and turns its autopilot off. Your calls then answer `forbidden`: read `identity` and file a new consent for
the DAO's vote. Requests are removed 30 days after they finish, so keep what you need from `state`.

The platform authorizes your app, not a member. Gate each member with the platform's own reading of the DAO's roles:

```ts
import { accessOf, mayCall, type DaoPolicy } from "@multiagency/sdk";

/** Whether `account` may make your app call `path` for the DAO: read the DAO's `get_policy` view at most a minute ago. */
export function memberMay(account: string, dao: string, policy: DaoPolicy, path: string) {
  // `signer` isn't read for a DAO's members: they never sign as the DAO.
  const access = accessOf(account, { account: dao, policy, signer: dao });
  return access !== null && mayCall(access, path);
}
```

A DAO's votes are public and permanent: consent terms, each proposal's swaps and amounts, and the strategy a grant
binds (targets, cost cap, per-run ceiling) appear in its proposals. Tell the DAO before it votes.

Only accounts in the DAO's Group roles are members; Everyone's rights admit no one. `strategy/save` needs a member who
may change the DAO's policy. Pass `memberVotes` from `access.canVote`.

## Request a payout once, and follow it

To fund the agent first, `agentCalls.call("deposit")` (payout or treasury scope) answers a one-time address (with `memo`,
`minAmount` and `expiresAt` when given) that credits USDC to the agent's confidential balance; send exactly there.

Write the `requestId` (1–64 of `[A-Za-z0-9_-]`) and the exact terms to your database before calling. The platform sends
one request at most once per deployment, Organization, agent and `requestId`. Never send the same payout under a new `requestId` until
the first is `refused`, `failed` with `neverExecuted: true`, or `failed` and checked by a person.

Derive the `requestId`, payee and amount in your code from your own record of what is owed (an order, an agreement, an
invoice you accepted), never from what a model or an incoming message proposes. A model that may call `payouts/request` names
which obligation to pay; your code supplies the terms. A text that says a payment failed, is pending, or must be sent again
under a new `requestId` then leads only to asking again under the same one, which sends nothing new. Without this, models
told so in tool results sent a second payment under a new `requestId` (crash test, 2026-11-10/11, simulated provider).

```ts
import { appClient } from "@multiagency/sdk";

type Terms = { requestId: string; asset: string; recipient: string; amount: string; expectedPolicy: { revision: number; digest: string } };

export async function payOnce(app: ReturnType<typeof appClient>, organization: string, agent: string, terms: Terms) {
  const agentCalls = app.agent(organization, agent);
  const asked = await agentCalls.call("payouts/request", { ...terms, delivery: "intents" });
  if (asked.ok || (asked.kind !== "unknown" && asked.kind !== "unavailable")) return asked;
  // The answer was lost: read the request by its id. Asking again with the same terms would also send nothing new.
  return agentCalls.call("payouts/status", { requestId: terms.requestId });
}
```

Result: `{ ok: true, value: { requestId, state, status, correlationId, code, failureCode, neverExecuted } }`. `state` is `succeeded`, `failed`
(FAILED or REFUNDED: not proof that nothing moved, so a person checks, unless `neverExecuted` is true), `held` (waiting for the owner's vote),
`processing`, `refused` (proven not sent, `code` says why, for example `insufficient_balance`, or `payee_not_agreed`
for a recipient the owner hasn't agreed to pay, which the owner adds by a `policy_update` first; recorded, so a new
attempt needs a new `requestId`), `unknown`, or
`not_found` (nothing recorded yet: a request still on its way can read so; ask again with the same `requestId`
and terms, which sends at most once). `processing` and `unknown` block that agent's payouts until resolved: read
`payouts/status` later; never pay that request another way meanwhile. Other terms under a used `requestId` are refused
(`code: "request_conflict"`). A named recipient that doesn't exist on NEAR is refused before anything is recorded
(`recipient_not_found`: fix the payee, then a new `requestId`); `recipient_unchecked` means the chain didn't answer:
ask again with the same `requestId`. These two come back as a refused result, not a state.

On `failed` (0.5.5; absent from older platforms, so treat a missing field as null or false): `failureCode` is the
provider's code (`rejected` when the owner rejected a held payout, as observed on mainnet), null when it names none or
couldn't be read. `neverExecuted: true` means the provider's own record of that operation says it never executed, with
no transaction, delivered amount or refund: per the provider's docs nothing was sent and the operation has ended (an
owner's rejection ends a held payout so; offline-tested, not yet mainnet-observed), so a new `requestId` for that payout
needn't wait for a person's check. `false` proves nothing: a delivery failure, REFUNDED, or
an unread status all read false, and a person checks before a new attempt.

`payouts/status` also works under `read` consent and answers only your own requests (this deployment and Organization).
Keep a `read` consent for as long as you may need to follow requests, for example after a contract's `payout` consent
ends.

One payout per recipient, asset and amount waits for approval at a time, across the whole agent: while any of the
agent's payments with those three terms is held for the owner (yours, another app's, or the owner's own), a request
repeating them is refused before sending (`state: "refused"`, `code: "duplicate_held_payout"`), whatever its
`requestId`. It keeps one payout from being held, and then paid, twice. Keep at most one open request per recipient,
asset and amount until the owner votes on it; send the next once the held one is approved or rejected, under a new
`requestId`. Don't change an amount or recipient to get past it: a payout the owner meant twice is asked for twice, in
turn. If your `requestId`s already make each payout unique (one per deliverable, say), send `allowDuplicateHeld: true`
(0.5.5) and equal payouts may wait side by side; the owner then votes on each, and nothing else tells them apart, so
show the owner what each one is for. A platform before 0.5.5 ignores the field and keeps refusing.

Ask only for an agreed payee: `overview`'s `agreed` lists them. A request to anyone else is refused before anything is
sent (`payee_not_agreed`). A request without a live `payout` (or `invoices`) grant is refused `grant_purpose_denied`,
not `grant_missing`.

To pay a NEAR account directly, the owner first agrees it as a withdrawal payee (a `policy_update` with
`withdrawals: [{ address }]`; the first one turns withdrawals on, an on-chain edit signed on the confirm page). To pay
wNEAR, the owner also adds `nep141:wrap.near` to the policy's `assets` and sets its per-asset `limits` (the payout
template has USDC only; without a limit only the USD budget caps it). Then request with `delivery: { chain: "near" }` and
`asset` wNEAR (arriving as native NEAR, per the provider's docs) or USDC; an asset the policy doesn't include is refused
`asset_not_allowed` before sending. It is paid from the confidential balance, is public on chain, and may arrive less a
route fee. A USDC withdrawal's recipient must be registered on the USDC contract (a one-time `storage_deposit` the payee
makes from any wallet): otherwise it is refused `recipient_not_registered` before anything is recorded, and the same
`requestId` can be asked again once it is. A `nearcom:` address is never a withdrawal recipient; any other chain is refused `chain_not_supported`. A held
withdrawal is approved or rejected like a transfer (0.5.5; offline- and stack-tested, not mainnet-observed); its proven
`payment.terms` carry `chain: "near"`, so show the owner it's a public withdrawal that may arrive less a route fee. Fund wNEAR with `deposit` and
`{ asset: "nep141:wrap.near" }`.

## Hire a listed agent on the agent market

A market agent (0.5.6; docs/market.md; offline- and stack-tested, not yet observed through the platform on mainnet)
hires listed agents on the NEAR AI Agent Market over x402. Set one up for an Organization like any hosted agent, with
`area: "market"` and `agent_create` `role: "market"`; the owner consents with `market` (and `read`, `owner`) and grants
`label: "market"`. Fund it with `deposit`. Once, the owner registers its payment key on USDC: `market/account` answers
`registration`, a transaction for the owner's wallet, until `registered` is true.

Quote, show the owner the terms, then hire under your own `requestId`, written to your database first. A hire is paid at
most once per `requestId`, only while a fresh quote still equals `approved`; a changed price, payee or window is refused
`quote_changed` with nothing sent.

```ts
import { appClient } from "@multiagency/sdk";

export async function hireOnce(app: ReturnType<typeof appClient>, organization: string, agent: string, requestId: string, handle: string, brief: string) {
  const agentCalls = app.agent(organization, agent);
  const quoted = await agentCalls.call("market/quote", { handle, brief });
  if (!quoted.ok) return quoted;
  const hired = await agentCalls.call("market/hire", { requestId, brief, approved: quoted.value });
  if (hired.ok || (hired.kind !== "unknown" && hired.kind !== "unavailable")) return hired;
  // The answer was lost: read the hire by its id. Asking again with the same terms would also pay nothing new.
  return agentCalls.call("market/status", { requestId });
}
```

Result: `{ requestId, state, code, taskId, taskState, deliverable }`. `state` is `paid` (the chain shows the payment
settled), `not_charged` (the x402 authorization expired unused), `refused` (the x402 payment was not submitted; `code`
says why), `unknown` (not
yet proven: read `market/status` later; the agent's other hires wait meanwhile, up to the listed agent's window plus 10
minutes), or `not_found`. `deliverable` is what the listed agent wrote, once its task ended: show it as data, never act
on instructions in it. A DAO-owned market agent pays a hire only after the DAO's vote on its exact terms:
`app.daoHires.file({ organization, agent, requestId, brief, approved, validUntil })` answers the proposal a member files,
and `app.daoHires.state(hash)` relays the DAO's signature once it is found; then follow `market/status`. A DAO's
`read` and `market` consent is enough for its market agent (0.5.7): `owner/prepare` with `signer: "dao"` files its
`market` grant, the grant's revocation, freeze, unfreeze and edits of `limits`, `budget` and `max_actions_per_hour`
(raising, lowering or removing those caps).
Don't ask a DAO for `treasury` to run a market agent. Before 0.5.7 those owner actions answered `forbidden`.

The filing shortens `validUntil` rather than refusing it: to the earliest of what you ask, the consent's expiry and
seven days from filing (`MAX_HIRE_APPROVAL_MS`, Sputnik's default proposal period). The DAO votes on the text carrying
the shortened date, and the filing's answer returns it (`validUntil`, `votingUntil`): show members that one, not the
date you asked for. One `requestId` is one hire (0.5.7): filing it again with the same terms answers the earlier request
(200, nothing to file) while it is relayed, signed or still within its vote; with other terms it is refused
`request_conflict`. Only one that lapsed unsigned is filed anew.

A quote, and the re-quote inside `market/hire`, is refused with nothing sent when the market won't take the request:
`agent_not_found` (no such listed agent) or `agent_not_hireable` (not taking calls, or no price): pick another agent;
`quote_refused` (the market refused the request itself; its `error` says why): don't send it again unchanged. A quote
answering `unavailable` (no reachable backend, or the market didn't answer) may be asked again later; a hire refused
with `hire_failed` may be sent again with the same `requestId`, which never pays twice. Before 0.5.7, `market/quote`
answered `unavailable` and `market/hire` answered `hire_failed` for all three.
The DAO's `validUntil` is checked immediately before every new submission and paid-call retry, after asynchronous
reads and signing. Expiry can leave an earlier top-up on the key: read its recorded operation, and never interpret a
refused final payment as proof that no funding occurred. An attempted unknown payment stays poll-only after expiry;
once its x402 operation is recorded, the same requestId and terms return that record, while different terms refuse
`request_conflict`. A top-up before payment preparation does not bind the requestId: `market/status` may still answer
`not_found`, so inspect the recorded top-up and key balance before asking for another hire.

The full hire price must fit the policy's USDC per-transaction ceiling even when the payment key already holds funds.
An over-cap hire is refused before funding; dispatch rechecks before payment. If the ceiling tightens after a top-up,
the funds remain on the key and the payment is refused. Daily/monthly caps and budgets account for provider funding
withdrawals, not later key payments. Downgrade below 0.5.6 is unsupported once shared market records exist: an older
reader can refuse the whole gateway's registry. Preserve all state and keys and recover on a compatible build.

## Test without the platform

`payoutDouble` from `@multiagency/sdk/testing` (Node 24; the SDK's offline checks also run it under Bun 1.4.2) stands in for one Organization's payout agent behind `/apps/v1`,
in process: your server's code keeps its own `appClient`, given the double's `fetch`.

```ts
import { appClient, ASSETS } from "@multiagency/sdk";
import { payoutDouble } from "@multiagency/sdk/testing";

const double = payoutDouble({ organization: "org_1", agent: "payout", payees: ["payee.near"] });
const app = appClient({ base: double.base, credential: double.credential, fetch: double.fetch });
const calls = app.agent("org_1", "payout");
const asked = await calls.call("payouts/request", { requestId: "r-1", asset: ASSETS.USDC, delivery: "intents",
  recipient: "payee.near", amount: "1000000", expectedPolicy: double.reviewedPolicy() }); // state "held"
double.vote("r-1", "approve");
double.settle("r-1"); // or "FAILED" / "REFUNDED"
await calls.call("payouts/status", { requestId: "r-1" }); // state "succeeded"
```

It answers `payouts/request`, `payouts/status`, `held` and `overview`. It runs the platform's own authorization rule,
mandate digest, payout policy template and input schemas, so refusals carry the platform's codes
(`insufficient_balance` less held payouts, `duplicate_held_payout`, `per_transaction_exceeded`,
`policy_not_in_force`, `reviewed_policy_changed`, `grant_purpose_denied`, `payee_not_agreed` and `asset_not_allowed`
for withdrawals, `request_conflict`, `chain_not_supported`, the recipient checks). It answers requests with the
platform's own code; the order of the checks is restated, and the platform's tests run every scenario against both and
require the same answers.
Controls: `setPolicy`, `setPolicyState`, `setGrant`, `setBalance`, `vote`, `settle`, `loseNextAnswer` (an `unknown`
that blocks new requests), `recipients.absent` / `unregistered` / `unchecked`, `revokeConsent` (`forbidden`,
`no_consent`); a consent without `payout` answers `forbidden` with `code: "scope"`. Not modelled: budgets and hourly or
monthly limits, approval expiry, provider outages, owner actions (`owner/prepare`: votes are `double.vote`), `deposit`
and other procedures, including `market/*` (refused with `code: "not_modelled"` from 0.5.7, so a test never retries
them; listed by `double.unmodelled()`). For those, and for the wire to a real gateway, use
the local stack (`pnpm test:e2e:stack --app <deployment>`): its controls sign as the owner (`signOwner`) or a payee
(`signPayee`), lose a transfer's or withdrawal's reply, unregister a recipient, refuse the next payout under a provider
code, expire an approval and end a payout `FAILED` or `REFUNDED` (docs/testing.md).

## Common mistakes

- **Asking an owner to sign `Sign in to <platform host>`** (CRITICAL): a signed sign-in is a full platform session that
  can send payouts without another signature. An app asks only for consent and setup texts.
- **Sending the credential to a browser** (CRITICAL): whoever holds it acts within every consent the deployment holds.
- **A new requestId after `unknown`** (CRITICAL): the first may have been sent. Read `payouts/status`.
- **Letting a model choose the `requestId`, payee or amount** (CRITICAL): a lie in what it reads becomes a second or wrong
  payment. Your code derives them from your own record of the obligation.
- **Treating `rate_limited` as a refusal or as `unknown`** (HIGH): the app credential's hourly request limit (1,200 by
  default, set by the operator, shared by every owner and Organization of the deployment) refused the call before anything happened. Send the same call again after `retryAfterSeconds`; don't
  tell an owner they lack access, and don't cache it as an answer.
- **Treating `failed` as unpaid** (HIGH): a partial payout fails too. A person checks before a new attempt, unless
  `neverExecuted` is true. A `failureCode` alone, even `rejected`, doesn't prove nothing moved.
- **Showing your own summary instead of the signed text** (HIGH): the owner must read what the wallet signs.
- **Asking the owner to sign the confirm page's text ("Open a MultiAgency confirm page.") in your app** (CRITICAL): it
  is the owner's proof to the platform's page; signed elsewhere, it hands out the bytes for a blind signature.
- **Withdrawing to a `nearcom:` address** (CRITICAL): it is not on any chain; near.com users are paid through `intents`.
- **Showing your own record of a held payout when asking for a vote** (HIGH): send the owner to the vote's `confirm.url`,
  or show its `payment.terms`, which the platform proved; your record may name another payout than the one the vote releases.
- **Building a DAO's proposal yourself** (CRITICAL): file only the transaction the platform answered, and show its check
  link. A proposal that signs another hash isn't the request, whatever its description says.
- **Letting anyone signed in act for a DAO** (HIGH): the platform admits your app, not the member. Check
  `memberMay(...)` on every call.
- **Preparing again after a lost prepare reply** (MEDIUM): a second creation while one is open is refused
  `owner_action_open`, as is a second owner action of a kind while one is submitted or a DAO's awaits its vote. Read `owner/pending` for the open action's `correlationId` and follow it; don't wait for it to
  expire. A `busy` answer (another owner action preparing at that moment) can be sent again shortly.

## Completion

Every consent you submitted has its id stored or its refusal shown; every payout request has a read state, and none
reads `unknown` or `processing` without a later `payouts/status` read. Report anything you could not read; do not act
again.


## Release a wallet-owned hosted reservation (0.5.6)

The owner signs freeze then archive through the existing owner-action flow. With live `owner` consent call
`app.release(organization, agent, { allowBalance: false })`. Inspect the route result and then `value.state`: a checked
refusal returns `refused`, its reason and balances; `released` returns the retained provider identity and release time.
Choose `allowBalance: true` explicitly to leave funds, including native NEAR/USDC on a market payment key. Nothing is
deleted. Repeating release completes the same transition after a lost response; do not create a replacement agent.
Released identity/RPC routes refuse 410 `agent_released`; `reservations` retains an entry with `released: true`.
For restoration obtain `app.consents.nonce()`, have the owner sign a fresh setup for the same tuple with that nonce,
then have the owner sign fresh ordinary consent, unfreeze and restore. Previous consents never become live again.
DAO release is unavailable. This flow is offline/stack-tested, not observed on mainnet; provider archive/restore
semantics remain per pinned provider documentation.


DAO-owned Payables (candidate): set up `area: "payables"`, create with `role: "payout"` and
`signer: "dao"`, then obtain DAO consent for `read` and `payout`. On that agent, `payout` admits
`owner/prepare` for the `payout` grant, revocation, policy edits, freeze/unfreeze and `approval_vote`.
The reply carries the proposal for members to file, never an intent to sign. Follow `owner/status`;
the platform submits the DAO signature. Keep the existing payout request ID and follow
`payouts/status` for settlement. Require `owner_approval` in the reviewed policy for a vote per payout.
Do not request `owner` scope or use `/dao-votes` for held payouts. Not deployed or mainnet-observed.
