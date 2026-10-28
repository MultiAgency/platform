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
`payout`.

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

With `owner` scope an app may prepare only what the owner can read when signing, or what the platform builds itself:
`agent_create` without payees (naming the key that signed the setup), `agent_freeze`, `agent_unfreeze`, `grant_issue`,
`grant_revoke`, and `policy_update` of `destinations` or `budget`. Everything else is refused before it reaches the
agent, and a destinations edit the provider makes on-chain is withheld (`forbidden`, from the gateway after the agent
prepared it, so that intent expires unsigned): the owner signs it on the platform; don't retry it.
Follow owner-workflows' prepare, sign once, submit once, status, through `app.agent(organization, agent).call(...)`.

## Set up a hosted agent for an Organization

Before an Organization has an agent, your server builds `setupMessage({ host, deployment, organization, owner, area,
expiresAt })` (at most an hour ahead) and the owner signs it like a consent; submit it with `app.setup(...)`. The answer
names the Organization's own agent and a setup consent that lets you relay only its creation: `agent_create` without
payees, naming the key that signed the setup. Then read `identity` until it is created, and ask the owner to sign a
consent naming its `agentId`. A 409 means it already exists or the deployment reached its agent limit on the host; a
503 means a check went unanswered: submit the same body again.

## Request a payout once, and follow it

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
ask again with the same `requestId`. These two come back as a refused result, not a state. Today only confidential
USDC through `intents` is paid.

## Common mistakes

- **Asking an owner to sign `Sign in to <platform host>`** (CRITICAL): a signed sign-in is a full platform session that
  can send payouts without another signature. An app asks only for consent and setup texts.
- **Sending the credential to a browser** (CRITICAL): whoever holds it acts within every consent the deployment holds.
- **A new requestId after `unknown`** (CRITICAL): the first may have been sent. Read `payouts/status`.
- **Treating `failed` as unpaid** (HIGH): a partial payout fails too. A person checks before a new attempt.
- **Showing your own summary instead of the signed text** (HIGH): the owner must read what the wallet signs.

## Completion

Every consent you submitted has its id stored or its refusal shown; every payout request has a read state, and none
reads `unknown` or `processing` without a later `payouts/status` read. Report anything you could not read; do not act
again.
