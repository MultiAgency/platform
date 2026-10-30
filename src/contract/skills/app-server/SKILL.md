---
name: app-server
description: >
  Use when building an app's server (for example the MultiAgency dashboard's) that reaches MultiAgency agents for its
  Organizations through @multiagency/sdk: the deployment's service credential, owner consents and hosted setup signed
  with the owner's wallet, reads and the owner actions an app may relay, and payout requests sent at most once per
  requestId and followed by status. Server side only; never in a browser. Not for an owner's own browser app (use
  owner-workflows) or payees (use payee-workflows).
metadata:
  purpose: 'An app server''s access to agents: credential, consents, relayed owner actions, and payout requests by requestId with recovery by state.'
  type: core
  library: '@multiagency/sdk'
  library_version: '0.3.0'
requires:
  - getting-started
  - owner-workflows
sources:
  - 'MultiAgency/platform:src/contract/app-client.ts'
  - 'MultiAgency/platform:src/contract/app-access.ts'
  - 'MultiAgency/platform:src/contract/app-consent.ts'
  - 'MultiAgency/platform:docs/agent-access.md'
---

# An app's server with appClient

Read getting-started and owner-workflows first. `appClient` runs on your server with the deployment's service credential
(`tap_…`), issued by the platform operator: a server secret, never sent to a browser. A call reaches an agent only
under a live owner consent for that Organization and agent, and only within the consent's scopes: `read`, `owner`, and
`payout`. The `/apps/v1` routes are not yet deployed on any hosted MultiAgency host; until they are, run them on the SDK
repository's local stack (`pnpm test:e2e:stack --app <deployment>`).

## Setup

```ts
import { appClient } from "@multiagency/sdk";

// `platform` is the platform host's HTTPS origin; `credential` comes from your server's secret store.
export const platformFor = (platform: `https://${string}`, credential: string) => appClient({ base: platform, credential });
```

Result: `await app.identity("payout")` answers `{ ok: true, value: { agent, owner, agentId, created, host, deployment } }`.
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

Result: `{ ok: true, value: { consent: { id, scopes, expiresAt, … } } }`; keep `consent.id` with the Organization. A
`refused` 400 means the text or signature was not accepted; 409 means the agent changed: read `identity` again and ask
the owner to sign a new text. Later calls answer `forbidden` once the consent ends (expired, revoked, or the owner's
signing key removed): the owner signs a new one. A 503 means a check went unanswered: read again.

## Relay an owner action

With `owner` scope an app may prepare `agent_create` without payees (naming the key that signed the setup),
`agent_freeze`, `agent_unfreeze`, `grant_issue`, `grant_revoke`, `policy_update`, and `approval_vote` on a held payout,
through `app.agent(organization, agent).call(...)`. Everything else is refused before it reaches the agent.

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
consent naming its `agentId`. A 409 means it already exists or the deployment reached its agent limit on the host; a
503 means a check went unanswered: submit the same body again.

## Request a payout once, and follow it

To fund the agent first, `agentCalls.call("deposit")` (payout scope) answers a one-time address (with `memo`,
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
withdrawal can be rejected, not approved, for now: show the owner the reject choice only. Under the payout template every
payout is held, so a withdrawal is paid only once the owner turns `owner_approval` off. Fund wNEAR with `deposit` and
`{ asset: "nep141:wrap.near" }`.

## Common mistakes

- **Asking an owner to sign `Sign in to <platform host>`** (CRITICAL): a signed sign-in is a full platform session that
  can send payouts without another signature. An app asks only for consent and setup texts.
- **Sending the credential to a browser** (CRITICAL): whoever holds it acts within every consent the deployment holds.
- **A new requestId after `unknown`** (CRITICAL): the first may have been sent. Read `payouts/status`.
- **Treating `failed` as unpaid** (HIGH): a partial payout fails too. A person checks before a new attempt.
- **Showing your own summary instead of the signed text** (HIGH): the owner must read what the wallet signs.
- **Asking the owner to sign the confirm page's text ("Open a MultiAgency confirm page.") in your app** (CRITICAL): it
  is the owner's proof to the platform's page; signed elsewhere, it hands out the bytes for a blind signature.
- **Withdrawing to a `nearcom:` address** (CRITICAL): it is not on any chain; near.com users are paid through `intents`.
- **Showing your own record of a held payout when asking for a vote** (HIGH): show the prepared vote's
  `payment.terms`, which the platform proved; your record may name another payout than the one the vote releases.

## Completion

Every consent you submitted has its id stored or its refusal shown; every payout request has a read state, and none
reads `unknown` or `processing` without a later `payouts/status` read. Report anything you could not read; do not act
again.
