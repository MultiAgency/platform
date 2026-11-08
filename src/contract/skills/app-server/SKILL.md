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
  library_version: '0.5.5'
requires:
  - getting-started
  - owner-workflows
sources:
  - 'MultiAgency/platform:src/contract/app-client.ts'
  - 'MultiAgency/platform:src/contract/app-access.ts'
  - 'MultiAgency/platform:src/contract/app-consent.ts'
  - 'MultiAgency/platform:src/contract/dao-roles.ts'
  - 'MultiAgency/platform:docs/app-access.md'
---

# An app's server with appClient

Read getting-started and owner-workflows first. `appClient` runs on your server with the deployment's service credential
(`tap_…`), issued by the platform operator: a server secret, never sent to a browser. A call reaches an agent only
under a live owner consent for that Organization and agent, and only within the consent's scopes: `read`, `owner`,
`payout`, and for Treasury `treasury` and `treasury-execute` (see treasury-app). No production MultiAgency host serves the `/apps/v1` routes yet; the operator runs them on a staging host for
its own tests. Until a production host does, build against the SDK repository's local stack
(`pnpm test:e2e:stack --app <deployment>`). Use only `/apps/v1` and the confirm page on the platform's host: it serves
nothing else (no sign-in or owner page), and setup there is for Payables agents only.

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

Your server builds the exact consent text and a 32-byte nonce; the owner's wallet signs it with NEP-413, recipient the
platform host, no callback URL; your server submits it. Show the owner the text the wallet signs.

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
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signed = await sign(message, host, nonce);
  const submission: AppConsentSubmission = { message, nonce: btoa(String.fromCharCode(...nonce)), ...signed };
  let stored = await app.consents.submit(submission);
  // No answer: the same signed body is safe to submit again; never ask the owner to sign again for that.
  if (!stored.ok && stored.kind === "unavailable") stored = await app.consents.submit(submission);
  return stored;
}
```

Result: `{ ok: true, value: { consent: { id, scopes, expiresAt, … } } }`; keep `consent.id` with the Organization. Decide
by `code` (`APP_GATEWAY_CODES`), not status: `signature_invalid` or `invalid_request` means the text or signature was not
accepted; `agent_changed`, `owner_changed` or `not_created` means the agent isn't the one the text names: read
`identity` again and ask the owner to sign a new text. Later agent calls answer `forbidden` once the consent ends, with
`code` `no_consent` (expired or revoked), `consent_revoked` (the owner's signing key removed) or `agent_changed` (the
agent was replaced): the owner signs a new one. `scope` means no consent covers that procedure. `unavailable` (503: a
check went unanswered) means send the same request again.

## Relay an owner action

With `owner` scope an app may prepare `agent_create` without payees (naming the key that signed the setup),
`agent_freeze`, `agent_unfreeze`, `grant_issue`, `grant_revoke`, `policy_update`, and `approval_vote` on a held payout,
through `app.agent(organization, agent).call(...)`. Everything else is refused before it reaches the agent. A vote the
platform can't verify (an expired or changed approval, other terms, a withdrawal approval naming unobserved fields) is refused before
anything reaches the provider (`refused`, code `local_authorization_held`), at prepare or at submit.

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
  if (confirm) openForOwner(confirm.url); // NEP-366: the owner reads the platform's record and signs there
  else if (intent?.standard === "nep413")
    await calls.call("owner/submit", { correlationId, signedData: await signReadable(intent) });
  return calls.call("owner/status", { correlationId });
}
```

Result: `owner/status` answers the outcome; read it again until it is final. Open a `confirm` link for the owner right
away (the intent expires in minutes). It shows the action's terms to whoever holds it; the bytes to sign go only to
whoever presents the owner's signature over the link's text, which the page asks the wallet for, and `owner/submit`
through the app is refused for it.

To stop quickly:
- If you turned autopilot on (treasury-app), call `autopilot/stop` first. Revoking your consent doesn't stop it: the
  schedule runs under the owner's grant, and once you revoke you can't reach the agent to stop it.
- Revoke your consent: `app.consents.revoke(consent.id)` needs no wallet signature and refuses your later calls under
  that consent (another live consent of yours for the agent stays live). It is permanent: to resume, the owner signs a
  new consent. It doesn't cancel a call already forwarded.
- Relay `agent_freeze` for the owner: it opens the confirm page, and the owner must sign there before the link expires
  (minutes). `agent_unfreeze` releases it the same way; `approval_vote` is only for held payouts.
- Treat anything `executing`, `processing` or `unknown` as possibly sent: neither step undoes it. Whether a freeze or a
  revoked grant stops a payout the provider already holds is not established
  ([enforcement](https://github.com/MultiAgency/platform/blob/main/docs/enforcement.md)).

A vote on a held payout names it from `held` (`approvalId`, `correlationId`). The prepared vote's `payment.terms`
(recipient, asset, amount) are what the platform proved against the provider's evidence: show those to the owner, not
your own record of the request. The vote's signed text holds only an identifier and a hash, so your display is the only
place the owner reads the terms. A payout an owner approves can still read `processing` until the provider settles it;
follow `payouts/status`.

## Set up a hosted agent for an Organization

Before an Organization has an agent, your server builds `setupMessage({ host, deployment, organization, owner, area,
expiresAt })` (at most an hour ahead) and the owner signs it like a consent; submit it with `app.setup(...)`. The answer
names the Organization's own agent and a setup consent that lets you relay only its creation: `agent_create` without
payees, naming the key that signed the setup. Then read `identity` until it is created, and ask the owner to sign a
consent naming its `agentId`. `already_created` means it already exists (ask for a consent); `setup_failed` says why
it couldn't be set up (for example the deployment's agent limit on the host); `unavailable` means a check went
unanswered: submit the same body again.

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
  `grant_revoke`, a `policy_update`, freeze or unfreeze. A policy edit's public proposal names only the fields it
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
proposal votes may take the DAO's voting period (at most 7 days). Creation, the grant, freeze and unfreeze are provider
intents with fixed windows, 600 s for wallet requests (creation, freeze, unfreeze) and about 290 s for consent messages (the grant), per the provider's docs (owner-signing, signing-standards, read 2026-11-05); nothing lengthens them. They complete only for a DAO whose vote passes that fast:
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
the first is `refused`, or `failed` and checked by a person.

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

Result: `{ ok: true, value: { requestId, state, status, correlationId, code } }`. `state` is `succeeded`, `failed`
(FAILED or REFUNDED: not proof that nothing moved, so a person checks), `held` (waiting for the owner's vote),
`processing`, `refused` (proven not sent, `code` says why, for example `insufficient_balance`; recorded, so a new
attempt needs a new `requestId`), `unknown`, or
`not_found` (nothing recorded yet: a request still on its way can read so; ask again with the same `requestId`
and terms, which sends at most once). `processing` and `unknown` block that agent's payouts until resolved: read
`payouts/status` later; never pay that request another way meanwhile. Other terms under a used `requestId` are refused
(`code: "request_conflict"`). A named recipient that doesn't exist on NEAR is refused before anything is recorded
(`recipient_not_found`: fix the payee, then a new `requestId`); `recipient_unchecked` means the chain didn't answer:
ask again with the same `requestId`. These two come back as a refused result, not a state.

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

## Common mistakes

- **Asking an owner to sign `Sign in to <platform host>`** (CRITICAL): a signed sign-in is a full platform session that
  can send payouts without another signature. An app asks only for consent and setup texts.
- **Sending the credential to a browser** (CRITICAL): whoever holds it acts within every consent the deployment holds.
- **A new requestId after `unknown`** (CRITICAL): the first may have been sent. Read `payouts/status`.
- **Treating `rate_limited` as a refusal or as `unknown`** (HIGH): the deployment's request limit (1,200 an hour, shared
  by every owner) refused the call before anything happened. Send the same call again after `retryAfterSeconds`; don't
  tell an owner they lack access, and don't cache it as an answer.
- **Treating `failed` as unpaid** (HIGH): a partial payout fails too. A person checks before a new attempt.
- **Showing your own summary instead of the signed text** (HIGH): the owner must read what the wallet signs.
- **Asking the owner to sign the confirm page's text ("Open a MultiAgency confirm page.") in your app** (CRITICAL): it
  is the owner's proof to the platform's page; signed elsewhere, it hands out the bytes for a blind signature.
- **Withdrawing to a `nearcom:` address** (CRITICAL): it is not on any chain; near.com users are paid through `intents`.
- **Showing your own record of a held payout when asking for a vote** (HIGH): show the prepared vote's
  `payment.terms`, which the platform proved; your record may name another payout than the one the vote releases.
- **Building a DAO's proposal yourself** (CRITICAL): file only the transaction the platform answered, and show its check
  link. A proposal that signs another hash isn't the request, whatever its description says.
- **Letting anyone signed in act for a DAO** (HIGH): the platform admits your app, not the member. Check
  `memberMay(...)` on every call.

## Completion

Every consent you submitted has its id stored or its refusal shown; every payout request has a read state, and none
reads `unknown` or `processing` without a later `payouts/status` read. Report anything you could not read; do not act
again.
