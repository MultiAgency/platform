# Independently built product frontends

Local infrastructure hardening changes the error contract: arbitrary exceptions now return generic
`INTERNAL_SERVER_ERROR`, while explicitly public application errors and provider codes remain
available. See [errors at the RPC boundary](architecture.md#errors-at-the-rpc-boundary).
Consumers must not branch on raw exception prose or automatically replay an action after a transport
error. Scoped RPC forwarding now has a fifteen-minute inactivity timeout (settlement may wait 180 seconds per leg); active streams may run longer.
These changes are offline-tested, not part of the deployed r2 artifact.

Proto can serve an independently built product frontend on a configured host while retaining its
same-origin gateway, host-bound sign-in and per-agent authorization. The frozen r2 integration
was deployed on 2026-10-16 UTC; see the [execution record](archive/proto-release-execution.md) for
the exact deployment, hosted checks and remaining limits. Offline integration tests remain
separate evidence and do not establish live money flows or state migration.

## Configuration

Add `frontendDist` to an existing entry in `dashboard.json`'s `hosts` map, for example:

```json
"frontendDist": "/app/frontends/treasury"
```

The value must be an absolute directory containing the built `index.html`. Configuration loading
fails if that entry is missing or is not a file. Paths come from deployment configuration, never
from a query parameter or forwarded header. Preserve that host's agent assignments and areas.
Hosts without the field retain Proto's `web/dist`. Payee intake keeps its existing routing.

The configured build serves the host's page routes, scoped `/a/<instance>/` pages, and static assets.
`/gw/*` and `/a/<instance>/rpc/*` continue through Proto's gateway. The actual request Host selects
both the build and sign-in audience; `X-Forwarded-Host` cannot select either. Each frontend runs
under its own product origin, with no cross-origin cookie sharing or CORS relaxation.

The default image builds only Proto's frontend. The shared-frontend release image must separately
package the selected product build at the configured path. DNS changes, image assembly and
rollout are not performed by the integration test. Keep one executor per agent; serving another
frontend does not require starting the sibling repository's gateway or executor.

## Treasury consumer contract

The Treasury repository retains standalone support and adds a shared-gateway adapter:

- `GET /gw/me`: `selfService: true` and `setupAreas` containing `treasury` enable Treasury setup.
  Explicit shared-host restrictions take precedence over `selfServiceTreasury`.
- Shared reservation: `POST /gw/agents` with `{ owner, kind, area: "treasury" }`, returning `{ name }`.
  The wallet owner comes from the authenticated viewer. Navigate to `/a/<name>/`.
- Standalone reservation retains `/gw/treasuries` and its existing input format.
- Malformed hosted discovery stays unavailable. HTML fallback is allowed only for intentional
  HTTP loopback local development outside `/a/` routes.

Reservation signs nothing and creates no provider agent. Owner signing, grants and money actions
retain their existing separate flows. The adapter does not migrate `.treasuries/` registrations
into Proto's `.hosted/` registry or reassign existing executors.

## Offline verification

Build the consumer repository independently, then run from Proto:

```sh
node scripts/test-shared-frontend.mjs /absolute/path/to/treasury/web/dist treasury
node scripts/test-shared-frontend.mjs /absolute/path/to/payables/web/dist payables
```

The runner accepts a built artifact rather than importing sibling server source. It removes
application credentials, points provider configuration at offline fixtures, and blocks Node
connections outside loopback. The browser blocks other hosts, popups and WebSockets; its two
fixture hostnames are forwarded over loopback to the real Proto gateway.

The check exercises a real NEP-413 challenge/signature and session, shared discovery, navigation
into an agent, scoped reads, missing-agent denial, signed-out denial, another owner's denial,
sibling-host session isolation, and HTML-discovery failure. The wallet key, chain responses and
agent observations are fixtures. Owner signing and money calls are absent. This establishes
frontend/gateway compatibility in the fixture, not provider behavior or mainnet readiness.

`test/frontend-config.test.ts` covers missing builds, relative path rejection and the optional
legacy default. Treasury owns its adapter tests and standalone regressions. The shared browser
check is explicit because it requires the independently built sibling artifact and Chromium.

## Payables consumer contract and verification

Shared hosts always advertise `setupAreas`, including `[]` when setup is disabled or no area is
assigned. Omitting this field would let a consumer mistake a shared host for a standalone gateway.
`test/shared-discovery.test.ts` reproduced that omission before the gateway fix and covers both
host restrictions and the global setup switch.

Payables enables setup only for `selfService: true` with `payables` permitted by `setupAreas`.
It reserves through `/gw/agents` using the authenticated wallet owner and `area: "payables"`, then
navigates to `/a/<name>/`. Its standalone `/gw/payables` behavior remains owned by the Payables repo.
Managed reservations advertise `managed: true` so setup retains their owner and area.
Shared payee links come from the selected agent's `invoices` field; missing links must not fall
back to the global intake. A payee page is public entry, while private payee records require
that instance's payee session.

The Payables browser variant additionally checks a real offline reservation for a second wallet
owner, scoped navigation, admission after child startup, and its discovered `/i/<name>/` payee
URL. A configured agent with no payee URL displays the unavailable message even when a global
legacy intake is configured. Wallet, chain and agent observations are fixtures; no owner action
or payment is submitted. The fixture waits for child readiness and reloads after reservation; this
does not establish automatic UI recovery during a slow production startup.

`test/hosted-gateway.test.ts` separately exercises the real managed payee routing and verifies
that a payee cookie cannot read another instance's work orders, even if its cookie name is
changed. These server checks complement the browser check; they are not a single deployed journey.
Positive payee-link rendering and exact work-order query preservation remain covered by the
Payables repository's reported adapter/browser tests, not by this real-gateway browser fixture.
Deployed wallet behavior, positive work-order journeys across both built frontends, image packaging,
DNS and rollout remain unverified here.

Validation on 2026-10-15 UTC: Proto typecheck and 741 offline tests passed. The independently
built Treasury and Payables artifacts each passed the shared browser check. Run these commands
sequentially with `pnpm test`: managed-agent fixtures allocate ports from the same 9000–9999 range.
The Payables check initially failed during fixture development and concurrent runs; the final
separate run passed. No sibling source edits, deployment, restart of live services, migration or
live-funds tests were performed.


## Explicit payee entry for an existing payout agent

The shared-frontend candidate configures `agents[].invoices` for the existing static `payout` as
`https://invoices.multiagency.ai/submit`. This is a deliberate mapping to its retained invoice
executor, not a global fallback. The field is optional, allowed only for `area: "payables"`, and
must be HTTPS without credentials or a fragment. Query fields are preserved. Static entries
without it still advertise no payee URL. Managed registrations retain their generated scoped
payee URL and never inherit this static mapping.

The Payables integration test verifies discovery, the selected static agent's invoice link, the
exact retained work-order query and reload, alongside a separate missing-link agent and managed
payee routing. `test/static-payee-route.test.ts` checks the production route/proxy forwarding
two different work-order IDs and other query fields without replay; only its HTTPS transport is
adapted to a loopback fixture. The public `/submit` route still reaches the retained invoice
executor. No executor assignment, grant, owner signing or state format changes are included.

Fallback review: public generated-domain challenge reads on 2026-10-15 still returned recipients
`treasury.multiagency.ai` and `payables.multiagency.ai`. These observations do not establish working
owner sign-in or private access on the generated domains. That release gate remains open until
owner-controlled browser verification is returned; no domain move or standalone restart occurred.

## Consumer source contract preflight

Run `node scripts/check-consumer-contract.mjs /absolute/path/to/consumer . payables` (or
`treasury`) before building or testing a consumer against Proto. `contracts/payables-frontend.json`
and `contracts/treasury-frontend.json` explicitly declare the required top-level procedure groups.
The checker first typechecks the actual frontend with its Router type restricted to those groups,
then compares the declared client contract with Proto, including procedure inputs and outputs.
Aliases and client factories retain TypeScript checking; backend-only imports keep their full
router. Undeclared frontend calls fail rather than disappearing from the comparison.

The existing TypeScript 7 compiler API supplies in-memory source overrides; it executes no backend
modules, copies no consumer source and changes neither sibling checkout. A changed client binding
that the adapter cannot restrict fails closed for review. Like any TypeScript check, explicit
`any` casts or untyped HTTP calls are outside this guarantee. The small adapter uses TypeScript's
unstable API and is covered by regression tests; compiler upgrades must pass those tests.
Proto owns the check; Treasury and Payables own requirements for their consumer declarations.
The optional `backend` mode retains the whole-router comparison for separate backend integration;
it is not a gateway behavior test. Omitted mode infers Treasury/Payables from the directory name,
otherwise it uses `backend`.

`test-shared-frontend.mjs` runs this check before browser startup when a consumer source tree is
adjacent to `web/dist`. Its optional fifth argument selects the consumer root; the fourth remains
the Proto runtime root. Standalone frozen artifacts without adjacent source explicitly report
that source compatibility was not checked and retain the existing browser-only check.

This conservatively compares all procedures within declared groups, including unused members. It does not
prove built-artifact provenance, runtime schema refinements, serialization/version compatibility,
discovery, gateway authorization, payee routing or safe error content. Retain build provenance
and HTTP/browser tests for those boundaries. No contract package or source copying is required.

Local source observation on 2026-10-16: Treasury passes. Current Payables fails on `compensation`,
which its frontend calls and Proto does not implement. `platformPayments` is used by Payables'
gateway, not its frontend, and is excluded from the frontend declaration. The earlier whole-router
failure for both names did not establish two frontend dependencies.

For this infrastructure phase retain the frozen r2 Payables artifact at
`/tmp/proto-infrastructure-review-20261015-r2/frontends/payables`, with the provenance in
[the release review](archive/proto-release-review.md). Do not substitute the current Payables build.
No production configuration or archive bytes were changed. Compensation remains a separate
Payables-owned feature integration covering its records, contributor endpoints and review flow;
Proto owns shared authentication, scoped routing, executor lifecycle and durable dispatch. Its
backend implementation ownership must be agreed before integration, with isolation, interrupted
preparation, duplicate submission and ambiguous-outcome acceptance tests. No placeholder endpoints
or fixture responses satisfy this release block.

Validation of this local candidate on 2026-10-16: typecheck, 775 offline tests and evidence
consistency passed. Sequential browser checks passed for the existing Treasury build and frozen
r2 Payables artifact. All 28 frozen Payables files were rechecked against `review-manifest.json`
and match. The current Payables build was refused by the narrowed frontend preflight on
`compensation` before browser startup. These observations establish neither a new build's
provenance nor deployed behavior.

## Bounded Payables journey check — 2026-10-16 UTC

The starting checkout was clean at `e38a7bd` (`lifecycle`), which contains the local
infrastructure hardening. The recorded deployed baseline remains r2
`09bf2aa6-d805-400a-97a8-7e55b7f131fa`; this check did not re-verify runtime hashes.

| Journey step | Evidence and limit |
| --- | --- |
| Owner entry and selection | Existing authenticated hosted Agreements rendered; prior r2 records cover Payments and owner admission. No work order was created. |
| Exact payee link | Hosted Agreements opened its advertised `/submit` entry. Exact work-order query forwarding is covered by `static-payee-route.test.ts` and the frozen consumer contract, not a live order. |
| Payee request and status | The existing browser session rendered the authenticated payee interface; its read-only work-order check returned no orders for that account. This establishes retained access, not fresh wallet sign-in. `invoices.cjs` covers synthetic request, agreement, held payout and subsequent outcomes. |
| Owner review | Existing work-order UI separates authorization, funding and held-payout approval. Browser and protocol tests cover those boundaries; no live owner signature or approval was attempted. |
| Recovery | `work-orders.cjs` reproduced selecting order B while the address retained order A. Reload could therefore return to the previous order. Store/restart tests separately retain the payment identity. |

The selected improvement fixes that demonstrated navigation failure in Proto's existing
`src/invoice-browser.js`: selecting **Review work order** replaces the URL's `workOrder`
parameter before reading the selected record. It preserves the payee path, other query
fields and fragment. It neither submits an invoice nor changes payment identity. This is
a narrow correction to the served payee runtime; Payables retains product ownership,
and no sibling source or compensation implementation was copied or changed.

The new two-order browser regression failed before the fix and passed afterward for both
`/submit` and managed `/i/<instance>/` entry. Reload reads only the selected order, retains
its unknown outcome with filing disabled, and sends no mutation. Invoice and scoped-payee
browser regressions also passed. These synthetic observations do not establish an exact live
owner-to-payee work-order journey, which remains unverified. The hosted visual inspection
also showed generic invoice guidance above work-order content; that is a usability judgment,
whereas the lost selection was reproducible and directly obstructed following an existing payment.

A follow-up offline regression reproduced another recovery failure: after the exact order's
initial read failed, **Check work orders** refreshed the list and cleared the error without
retrying the selected record. The handler now uses the validated URL reference when no order
has loaded. With polling paused, the test verifies an explicit retry, a persistent error while
the read still fails, and recovery to the same order when the read succeeds. Both payee
entry forms retain the unknown outcome and issue no mutation. This is local browser evidence;
no hosted outage or production recovery is claimed.

No deployment, production restart, wallet signature or money action occurred. Money-path files,
executor assignments and state formats were unchanged. The frozen r2 artifact was not modified.

Validation: `pnpm typecheck`, all 775 offline tests, `pnpm evidence:check`, the three targeted
browser suites (`work-orders.cjs`, `invoices.cjs`, `hosted-payee.cjs`) and `git diff --check`
passed. Browser/IPC checks required execution outside the filesystem sandbox; offline test
network restrictions remained enabled. The initial sandbox failures are not passing evidence.
