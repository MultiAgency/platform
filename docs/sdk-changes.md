# @multiagency/sdk changes

Every SDK change appends a note under the next version's heading when it is made: what changed for the apps, and any
wire change all apps must update for together. The first change after a release moves `package-version.ts` to the next
version, so a package staged or packed from changed sources never carries a released version's number. The release
candidate dates the heading. Under 0.x, any public-interface change bumps at least the minor version.

## 0.3.0 (not released)

All additive. Nothing on the existing wire changes.

- **App access for an app's server** (the MultiAgency dashboard is the first app): `appClient({ base, credential })`
  for the platform's new `/apps/v1` routes, which aren't deployed yet. `identity(agent)`, `setup(...)`, and
  `consents.list/submit/revoke` answer with `AppRouteResult` kinds (`session`, `forbidden`, `refused`, `unavailable`;
  resending the same signed body is safe). `agent(organization, agent).call(...)` uses `ownerClient` and its result
  kinds, typed to `AppProcedure` (`APP_READS`, `APP_OWNER`). `owner/prepare` takes only `AppOwnerAction`: agent
  creation without payees, freeze, unfreeze, grants, policy edits, and votes on held payouts; the gateway enforces the
  same list (`appMayAsk`). A NEP-413 intent comes back as `intent`; a NEP-366 one comes back without it, as
  `confirm: { url, expiresAt }` (`appConfirm`): open the platform's confirm page for the owner, then follow
  `owner/status`. A prepared vote answers `payment` with the held payout and, for approve, its recipient, asset and
  amount as the platform proved them against the provider's request hash (`ownerPrepareOutput`).
- **Payout requests:** `payouts/request` (`requestId`, `asset`, `delivery` (`"intents"` or `{ chain }`),
  recipient, amount, reviewed policy; only confidential USDC through `intents` is paid yet: another asset is refused
  `transfer_not_allowed`, a chain delivery before anything is recorded) and `payouts/status`, answering `payoutRequestOutput` (`state`: `succeeded`, `failed`, `held`, `processing`,
  `refused`, `unknown`, `not_found`; `failed` doesn't prove nothing moved). A request is sent at most once per caller and `requestId`; asked again it sends nothing; other
  terms under the same `requestId` are refused (`refused`, code `request_conflict`). Owners reach them with `ownerClient`
  (capability `payables-payout-requests-v1`), apps with `payout` consent (`APP_PAYOUT`, which also covers `deposit`: a
  one-time address that credits USDC to the agent, so an app can fund it).
- **The oRPC client is bundled.** `@orpc/client` is no longer a direct dependency: the SDK's own client calls use the
  copy it carries (`dist/contract/orpc-client.js`, licenses in `THIRD-PARTY-NOTICES`), so an app whose bundler shares
  `@orpc/client` (Module Federation shares bare names only) no longer mixes its copy with the SDK's link. `@orpc/contract`
  still imports its own `@orpc/client` (installed with it); the SDK's calls don't go through that copy. `@orpc/contract` stays a dependency (apps implement
  servers from the contract objects); `zod` stays the one peer.
- **Fix: `ownerClient` (and so `appClient`) keeps an encoded refusal's kind when the app's bundler splits oRPC.**
  Module Federation shares `@orpc/client` but not `@orpc/client/fetch`, so the link's `ORPCError` came from another copy
  and failed `instanceof`: a proven refusal read as `unknown` and a 401 as `unavailable` (found in the dashboard's built
  API, 2026-10-27; reproduced here). Errors are now recognized by name and `code`.
- **Recipient check on every transfer:** a payout (`pay`, invoices, compensation, payout requests) to a named account
  that doesn't exist on NEAR is refused `recipient_not_found` before anything is recorded or sent; `recipient_unchecked`
  when the chain didn't answer. Both are refusals (`kind: "refused"`); implicit ids are never read.
- **Skills:** `app-server` added (the app's credential, owner consents, relayed owner actions, payout requests by
  `requestId` with recovery by state, and never asking an owner to sign the platform's sign-in text); getting-started
  names the app deployment identity and `appClient`. Each example typechecks and runs against stand-ins of the app routes.
- **Consent and setup texts:** `consentMessage`, `setupMessage`, their parsers, `appConsentSubmission`, `AppScope`, and
  the route answer schemas (`appAgent`, `appConsentView`, `appSetupStored`).

## 0.2.0 (2026-10-26)

All additive. Nothing on the wire changes, and 0.1.0 consumers keep working unchanged.

- **Published on npm under Apache-2.0** (copyright MultiAgency LLC; `LICENSE` and `NOTICE` ship in the package).
  Install with `pnpm add @multiagency/sdk zod@4.6.7`; 0.0.1 and 0.1.0 were supplied as tarballs only and are not on npm. The
  package `repository` and the skills' `sources` name the public repository `MultiAgency/platform`.
- **`unresolved` declares `evidence`** (`unresolvedEvidence`): what the provider answered when a claimed submission
  failed without a proven outcome (Recovery B, already sent by the server). It is diagnostic only. `requestId` names the
  failed request to quote to the provider, and `providerIds` are unverified; neither is a correlation, and evidence never
  resolves or clears the operation. It is absent from older servers and null without a record. Malformed evidence parses
  as null, so it can never turn the blocking operation's read into `unavailable`.
- **Owner guidance:** `pay`, `sweep` and `autopilot/tick` return no caller-held identity, so `unknown` can't be looked up
  by one. owner-workflows now says how to recover them (`unresolved`, `held`, `activity`, then a person decides).
- **`ownerClient` takes an absolute base** (`OwnerBase`), for example Treasury's machine route
  `https://<host>/machine/v1/a/<agent>`. It adds no credential: the caller's `fetch` adds the bearer. owner-workflows has
  the example.
- **Gateway types:** `gatewayDiscovery` (`GET /gw/me`), `gatewayAgent`, `gatewayAccess`, `gatewayDenial` and
  `gatewayDenialScope()`. A gateway `session`/`forbidden` failure now carries the `scope` its body declares (`session`,
  `agent` or `procedure`), and omits it when the body declares none.
- **`@multiagency/sdk/release-server` has types** (`release-server.d.mts`).
- getting-started lists the supported exports per entry. payee-workflows says that invalid input throws before sending,
  and that the client takes no abort signal.
- **Owner failures keep their HTTP facts.** `refused` carries the encoded refusal's HTTP `status` and oRPC `rpcCode`.
  A plain (unencoded) HTTP error adds `httpStatus` to `unavailable` or `unknown`. It stays a diagnostic: a 404 for a
  procedure a host lacks is still `unknown` after an action, since nothing in the answer proves the handler didn't run.
- **A denial says who refused:** `session` and `forbidden` carry `source`: `"gateway"` for the gateway's plain answer
  (refused before forwarding) or `"agent"` for the agent server's encoded error. The type marks it optional, so failures
  an app builds itself keep compiling.
- An error body is recognised by oRPC's error shape (`defined`, `code`, `message`, `data`). The client tests
  (`test/contract-owner.test.ts`) pass with beta.46 on both sides; the beta.44 pairings are below. A body with other keys,
  such as a `status` field from another oRPC version, isn't, so it stays `unknown` after an action. That is the pinned
  wire, not a refusal Proto sends.
- On 0.1.0 an absolute base already worked at runtime; adopting it there needs only a type cast.
- **`gatewayDiscovery` never throws:** a payee entry that isn't an HTTP(S) URL fails the parse (it used to throw from a
  refinement).
- **A README ships in the package:** installation from npm or a linked checkout, which client fits which
  caller, first reads, the report workflow, and outcome handling.
- **payee-workflows has a complete report example:** every field, a new request versus a revision, draft versus
  submission, the optional proposed amount, retained identities, and recovery that counts a request as changed only when
  its version passed the command's `expectedVersion`, so a lost revision isn't read as applied. It also lists the
  refusal codes, the five request states with who acts next, and the payment statuses with where they come from.
- getting-started says which result kinds prove nothing was sent, including `provider` after an action, and what a
  throwing `fetch` becomes.
- The version moved to 0.2.0 as soon as these changes landed, so a package staged from these sources never packs as
  0.1.0.
- **oRPC and AG-UI are dependencies, no longer optional peers.** The owner entry brings `@orpc/client` and
  `@orpc/contract` 2.0.0-beta.46 and `@ag-ui/core` 1.0.3 itself, so an app on another oRPC version (the dashboard is on
  1.14.3) typechecks and calls the owner procedures with them. zod stays the one peer. Apps that installed the three
  for 0.1.0 may keep or remove them.
- **Wire compatibility with beta.44 (offline and local only, 2026-10-26; nothing hosted was tested).** Apps built on
  0.1.0 (oRPC beta.44 clients) against this server on beta.46: the isolated E2E suite (`test/e2e/run.mjs`, simulated
  provider) passed with the frozen Invoices, Payables and Treasury releases and Treasury's published skill helper on its
  own beta.44 install. This client (beta.46) against a local beta.44 server: a read and a typed refusal gave the same
  results as same-version pairs. The payee routes are plain HTTP and don't depend on oRPC. Whether the hosted server
  runs beta.44 is not established here; this version has not been tested against it.
- **Run recordings declare AG-UI 1.0.3.** `RecordingSchema` still reads recordings that declare 1.0.2, and
  `Recording["aguiVersion"]` is now `"1.0.2" | "1.0.3"`.

## 0.1.0 (2026-10-19)

- **Shared builder payouts.** A fresh report may now be paid from the payout agent's shared balance: the owner chooses
  `mode: "shared"` or `"isolated"` at `compensation/prepare`. A request already bound to one path keeps it
  (`payment_bound`).
- **Approval states the amount.** `compensation/review` with `decision: "approved"` requires `approvedAmount`
  (`amount_required` otherwise); a report's requested amount is only a proposal. Payables already sends it.
- `requestRecord` loses `payoutMode`. Payee clients that parse it are unaffected (unknown keys are dropped); no
  capability id changes.
- **Removed export:** `compensationAmount` (from `./payee`). Show `approvedAmount` as the compensation and the report's
  amount as requested. `approvedCompensation` returns `approvedAmount` and now throws when an approved request has
  none; 0.0.1 fell back to the report's amount.
- **Retryable local refusals.** A send refused by Proto's own checks before submission (for example
  `insufficient_balance`, `reviewed_policy_changed`, `payee_not_agreed`) now fails `compensation/send` with that code
  and leaves the payment prepared on its identity; sending again after fixing the cause pays it once. Provider refusals
  and unknown outcomes are unchanged.

## 0.0.1 (2026-10-18)

Numbering restarts at 0.0.1; the earlier local tarballs (`@multiagency/proto-contract` 1.0.0–1.5.0, `@multiagency/sdk`
1.6.0) are history. No backwards compatibility with them.

- Package `@multiagency/proto-contract` → `@multiagency/sdk`. Payee entry `./supplier` → `./payee`.
- Payee names in code: `payeeClient`, `payeeContract`, `compatiblePayeeFrontend`, `payeeWorkOrderRequest`,
  `payeeCompensationView`, `PAYEE_REPORT_PERMISSIONS`. No aliases.
- **Wire change, all apps together:** an agent connection's `role` is `"payee"` (`PAYEE_ROLE`). 1.5.0 clients (Invoices G
  and earlier) reject it, so those releases are not rollback targets across this change.
- Hosted contributor sessions signed before this release end once (their session key derivation changed).
- Unchanged on the wire: routes, `supplier-*-v1` capability ids, cookies, records.
- Agent guidance ships as TanStack Intent skills: `getting-started`, `owner-workflows`, `payee-workflows`
  (`npx @tanstack/intent@0.5.5 list`). Every example is typechecked and run against the packed tarball.
