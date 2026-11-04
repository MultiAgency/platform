# Building an app on the platform

How a team builds an app that uses the platform's identity, consent, records and guarded execution instead of copying
them. Apps live in their own repositories and depend only on `@multiagency/sdk`. Start with the package README
(`src/contract/README.md`, shipped as the package's `README.md`) and its bundled skills. This page covers what the
platform side expects. The [reuse map](archive/reuse-map.md) records which workflows reused each piece as of 2026-10-16.

## Who owns what

| The platform provides | The app owns | Never in an app |
| --- | --- | --- |
| Owner consent and app credentials (`/apps/v1`), or host-bound sign-in for a browser product (`/gw/*`) | Its UI, copy, navigation and server | A gateway, executor, grant token or provider credential |
| Per-agent, per-procedure authorization on every call | Non-authoritative drafts and preferences | Authoritative payment, treasury, proposal or owner-intent records |
| Owner actions: prepare, the owner's signature (in the app, or on the platform's confirm page), one submission, durable status | Which owner actions it offers, and how it explains each | Signing for the owner, or treating approval as settlement |
| One send site (`dispatch`), unresolved-operation blocking, reconciliation | Its own release and rollback | Callbacks into the platform (none exist; a demonstrated need comes first) |
| The isolated stack and simulated provider for local proof | Its own tests | Live funds, credentials or production state |

## An app with its own server: `appClient`

The path for the separate app repositories; the dashboard and Treasury are moving to it. The `app-server` skill has
the complete examples, and `treasury-app` covers Treasury proposals.

1. **Get a service credential.** The platform operator issues the deployment's `tap_…` credential
   (`pnpm app-credential`). It is a server secret: never in a browser, URL or log.
2. **Ask the owner for consent.** The app's server builds `consentMessage(...)` (or `setupMessage(...)` for a hosted
   agent that doesn't exist yet), the owner's wallet signs it with NEP-413 in the app, and the server submits it. The
   consent names one host, deployment, Organization, agent and its scopes (`read`, `owner`, `payout`, `treasury`,
   `treasury-execute`), and it expires.
3. **Call within the consent.** `appClient({ base, credential }).agent(organization, agent).call(...)` reaches only the
   reads and actions its scopes list. Everything else is refused before it reaches the agent.
4. **Relay owner actions.** `owner/prepare` answers either a NEP-413 intent the owner reads and signs in the app, or,
   for a NEP-366 action, a `confirm` link to the platform's confirm page (`/confirm/<token>`). A NEP-366 action is bytes
   the wallet can't show, so the page shows the agent's own record of its terms and releases the bytes only to the key
   the action names: an app can't hand the wallet a different action. The app then follows `owner/status`; it never
   signs or submits again.
5. **Send money once.** A payout request or a proposal's execution carries the app's `requestId`, recorded before the
   call; the platform acts on it at most once. After `unknown`, read its status by that id; never retry under a new one.
6. **Test on the stack.** `pnpm test:e2e:stack --app <deployment>` (add `--treasury` for Treasury) starts the real
   gateway, agent servers and simulated provider, and issues the app's credential at startup.
   `test/e2e/stack-app.spec.mjs` is the reference app server.

Status: wallet-owned agents; for DAO-owned agents, consent, proposal votes and the Treasury grant by DAO vote (`read`,
`treasury`, opt-in `treasury-execute`; offline- and stack-tested), and freeze and unfreeze by DAO vote (offline-tested).
The `read`, `owner` and `payout` scopes are mainnet-observed on platform staging (2026-10-28, 2026-10-30) through the
platform's own stand-in app; `treasury` and `treasury-execute` are offline- and stack-tested. No production host serves
`/apps/v1` yet. Details: [app access](app-access.md).

## A browser product on a configured host: `ownerClient`

A page the platform serves on one of its hosts, using the owner's session there.

1. **Choose a host and its agents.** A host entry in `dashboard.json` names its `demo` value, its agents and, for an
   independent build, `frontendDist`. `demo` is a fixed enum (`showcase`, `payables`, `treasury`, `invoices`) and agents
   have area `payables` or `treasury`; a new value needs a reviewed platform config change.
2. **Declare capabilities.** Ship a `contract.json` with `version`, `product` and `required` capabilities
   (`ownerCapabilities` and `payeeContract` in the SDK name them). On a host served by the shared release server
   (`frontend` host config) the gateway checks it before serving HTML and refuses an incompatible release (503, records
   unchanged). A legacy `frontendDist` directory is not checked.
3. **Call same-origin through the gateway.** Sign in with `/gw/challenge` → wallet `signMessage` → `/gw/session`, read
   the account from `/gw/me` with `gatewayDiscovery`, then use `ownerClient({ base: "/a/<agent>" })`.
4. **Keep the owner action's identity.** `owner/prepare` → keep the `correlationId` durably → show `preview.summary` →
   the wallet signs `intent.payload` (NEP-413) → `owner/submit` once → follow `owner/status` for that `correlationId`.
   After a lost reply or a reload, follow that record; never sign or submit again.
5. **Release independently.** Follow the Invoices asset-service convention ([invoices-extraction.md](invoices-extraction.md)):
   an immutable artifact that keeps old hashed assets during rollout and rolls back without touching backend records.
   Offline E2E only (`owner-release`, `treasury-migration` specs); not deployed.
6. **Test on the stack.** `pnpm example:build`, then `pnpm test:e2e:stack --frontend examples/minimal-prototype/dist`
   (or your build's absolute path). See [testing.md](testing.md).

`examples/minimal-prototype/` is the reference: one rsbuild page that signs in through the gateway, reads `overview` for
the `payout` agent and pauses or resumes it with an `agent_freeze`/`agent_unfreeze` intent, keeping the `correlationId`
across a lost reply and a reload. `test/e2e/minimal-prototype.spec.mjs` runs it on the real gateway with a simulated
provider, including a lost preparation reply and a lost submission reply, with one signature and one submission in
total. It is offline-tested only.

## Gaps

- DAO-owned agents: Treasury only (no `payout` or `owner`), and owner intents (creation,
  grant, freeze) complete only when the DAO's vote passes within minutes.
- Host `demo` and agent `area` are fixed enums.
- Owner procedures outside the Treasury/Payables set (for example `ownerIdentity`, `demoGuide/compose`) have no packaged contract.
- Independent owner-app releases are proven on the local stack only.
- No app-callback channel exists. Any server-side need is reviewed first.
