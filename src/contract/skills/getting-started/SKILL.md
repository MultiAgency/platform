---
name: getting-started
description: >
  Use when deciding how an app or external agent should work with MultiAgency agents through @multiagency/sdk: which client
  to use (owner or payee), how each kind of identity signs in and what the server enforces for it, how results report
  refused, unavailable and unknown outcomes, and what this package version supports. For owner tasks use owner-workflows;
  for payee tasks use payee-workflows.
metadata:
  purpose: 'Orients an app or agent author: the two clients, the four identities and their server-side limits, recovery kinds, and the supported surface of this package version.'
  type: lifecycle
  library: '@multiagency/sdk'
  library_version: '0.3.1'
sources:
  - 'MultiAgency/platform:src/contract/index.ts'
  - 'MultiAgency/platform:src/contract/payee-entry.ts'
  - 'MultiAgency/platform:docs/agent-access.md'
---

# Working with MultiAgency agents

Each agent moves funds for its **owner** (a NEAR account or a Sputnik DAO) only inside the policy the owner signed.
This package gives apps and agents typed access to two kinds of work. It grants no authority: every call is authorized
by the gateway and the provider, never by the client or by this guidance.

1. Pick the client for the identity you act as (table below). Result: one of `ownerClient` (entry `@multiagency/sdk`),
   `appClient` (same entry, an app's server) or `payeeClient` (entry `@multiagency/sdk/payee`, zod only).
2. Get that identity's session the supported way. Never handle a wallet's private key or copy browser cookies into an
   agent. Result: calls return data; a `session` (401) result means sign in again.
3. Do the task with owner-workflows, app-server or payee-workflows.
4. Keep every identity you send (`correlationId`, `commandId`, request `id`, `planId`) until you have read its outcome.
   Some owner actions (`pay`, `sweep`, `autopilot/tick`) carry no identity; owner-workflows says how to recover them.

## Identities and what the server enforces

| Identity | How it is obtained | Reaches | Enforced server-side |
| --- | --- | --- | --- |
| Owner session | NEP-413 sign-in in a browser at the agent's host (`/gw/challenge` → wallet signs → `/gw/session`) | `/a/<agent>/rpc/*` through `ownerClient` | Access per agent from the wallet owner, or from the DAO policy for a member (propose, vote; execute and manage derived). A member never acts or spends as the DAO alone: owner actions need the owner's signature (a DAO vote). Calls outside access: 403. |
| Treasury machine credential | Issued by a wallet owner of a Treasury agent from the owner's session (`tmc_…` bearer) | `/machine/v1/a/<agent>/rpc/*` (Treasury's skill helper, not this package) | Fixed scopes (read, prepare, execute-plan, sweep), expiry, revocation, the owner's fresh access re-checked per call. Treasury only; DAO owners cannot issue it. |
| App deployment credential | Issued by the platform operator per app deployment (`tap_…` bearer, a server secret), plus an owner-signed consent per Organization and agent | `/apps/v1/*` through `appClient` (server side only) | The consent's scopes (`read`, `owner`, `payout`), Organization and agent; owner actions only those the owner can read or the platform builds; the owner's key and ownership re-checked per call; revocation. Wallet owners only. |
| Payee session | NEP-413 sign-in on the payee entry (`/api/signin`) | `/api/*` on that entry through `payeeClient()` | Only the signed-in account's own invoices, work orders and reports. An account that has only requested onboarding terms is not yet a payee: an agreement makes it one. |
| Agent connection | Started by the payee from their signed-in browser session (`tac_…` bearer, shown once) | `GET`/`POST /api/compensation`, `GET /api/compensation/session` through `payeeClient({ base, token })` | Bound to host, entry, account and payout agent; expiry (at most 24h) and revocation; every other route 403 with no effect; never a browser session; each call attributed. |

## Results: decide by `kind`, never by message text

| `kind` | Meaning | Nothing was sent? | What to do |
| --- | --- | --- | --- |
| `ok: true` | The answer, validated against this version's schema | n/a | Use `value` |
| `session` | 401: no valid session | Yes | Sign in again (agent connection: start a new one) |
| `forbidden` | 403: this identity may not do this | Yes | Do not retry; it is a permission, not an outage |
| `refused` | Refused before anything was sent (optional `code`; owner results also carry the HTTP `status` and oRPC `rpcCode`) | Yes | Correct the input or state, then act again |
| `busy`, `unresolved` | Owner money actions: another action holds the lock, or an earlier one has no proven outcome | Yes | Follow existing operations, then try again |
| `provider` | After an owner action, the provider's answer proves it refused; after a read, the provider read failed | Yes, for an action | Check the recorded outcome before acting again |
| `unavailable` | A read failed or lost its answer | n/a (a read) | Reading again is safe |
| `unknown` | An action was sent and its outcome is not known (`identity` is the input you sent) | Not known | Never resend. Read the record by the kept identity, or follow owner-workflows when the action has none |

`unavailable` and `unknown` may carry `httpStatus` when the answer was a plain HTTP error rather than an encoded one (a
proxy page, or a 404 for a procedure the host doesn't have). It is a diagnostic: it doesn't prove that nothing ran. A
`fetch` you pass in that throws (a timeout, a refused redirect, your own origin check) is a lost answer too: `unavailable`
for a read and `unknown` for an action. A command-line helper can map these to exit codes, for example `0` for `ok`, `2`
for a kind that proves nothing was sent, and `3` for `unknown`, so a script never treats an unknown outcome as a failure
it may retry.

## What this package version supports

`@multiagency/sdk` 0.3.1, entries:
- `@multiagency/sdk`: `ownerClient` with `OwnerResult`/`OwnerFailure`, `appClient` with `AppRouteResult` and the
  consent and setup texts (`consentMessage`, `setupMessage`), `ownerOutputs` and `OwnerInputs`/`OwnerOutput`
  per procedure, `ownerCapabilities` and `mayCall` (display only), gateway discovery (`gatewayDiscovery`,
  `gatewayDenialScope`), schemas for runs (`RecordingSchema`) and proposals, `ASSETS` and account helpers. It also
  re-exports the payee entry. Peer: zod ^4.6.5. It bundles `@orpc/client` 2.0.0-beta.47 and loads no other oRPC
  package, so it runs beside a host that shares its own oRPC. It depends on `@ag-ui/core` 1.0.3.
- `@multiagency/sdk/contract`: `ownerContract`, `ownerErrors` and `OwnerContract`, for an app implementing a server
  from the contract. It loads `@orpc/contract` 2.0.0-beta.47, a dependency.
- `@multiagency/sdk/payee`: `payeeClient` with `Result`/`Failure`, payee and compensation schemas, agent-connection
  schemas, `payeeContract` and `compatiblePayeeFrontend`. Peer: zod only.
- `@multiagency/sdk/release-server`: `stage`, `activate`, `readRelease`, `digest` and `releaseServer` for app
  releases, and the `multiagency-release-server` command. Node only: its types use `@types/node`.
- `@multiagency/sdk/schemas/*`: JSON Schemas of the payee and compensation wire for non-JavaScript consumers.

Other exports (the owner contract object, server input schemas, capability helpers the gateway uses) are available,
but they follow the platform's needs and may change without notice.

The payee entry's capability ids are still `supplier-*-v1` (check them with `payeeClient().capabilities()`); an agent
connection's `role` is `PAYEE_ROLE`. Compare against the exported constants, never against literal strings.

## Completion

The task is done when the client answers `ok` for the reads you need and every action's outcome has been read by its
kept identity. If a result is `unknown`, the task is not done until the record is read; if it stays unreadable, report
it rather than acting again.
