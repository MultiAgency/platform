# Shared-host infrastructure review — 2026-10-16 UTC

This review targets the existing single-host installation. Changes below are local and offline-tested;
they have not been deployed. No credential rotation, production restart, owner action or money action
was performed. Gateway processes are application isolation, not OS sandboxes or distributed fencing.

## Findings and disposition

| Priority | Finding / reproduction | Owner and correction | Acceptance / remaining limitation |
| --- | --- | --- | --- |
| Release gate | The release execution record reports credentials printed by a diagnostic | Owner-controlled rotation; Proto prepares the [rotation procedure](../credential-rotation.md) | Still outstanding. Baseline variable names do not establish the complete exposure set. |
| High: disclosure | An actual HTTP RPC response returned a synthetic credential and private path from an arbitrary exception; streaming uses the same conversion | Proto `rpc/base.ts`: generic internal errors; provider detail/title omitted; explicitly public application errors retained | `rpc-errors.test.ts` covers HTTP, stream failures and provider metadata. This does not certify every successful response or private log as secret-free. |
| High: build confidentiality | Both repository Docker ignore files omitted `.test-artifacts` (containing the private whole-volume archive), hosted/work-order state and backup patterns | Proto: exclude private artifacts, state and backups in both contexts | `build-context.test.ts` pins the exclusion policy. No upload or Docker build was performed. No evidence of an earlier upload is claimed. |
| High: lifecycle | A real gateway exited successfully before a real synthetic child completed its delayed signal handler | Proto: a supervisor owns children and restart timers; shutdown waits for children and HTTP connections | `gateway-lifecycle.test.ts` failed before the fix; supervisor tests cover failed spawn, crash restart, duplicate start, shutdown during startup and forced termination. |
| Medium: availability | An accepted synthetic RPC request that never returned outlived the test's client deadline | Proto: extracted RPC forwarding with a fifteen-minute socket inactivity timeout | `rpc-proxy.test.ts` failed before the timeout; returns uncertainty without resending. The initial 30-second limit was corrected: settlement may wait 180 seconds per leg. Active streams may exceed the idle limit. |
| Retained limitation | Executor shutdown is not a promise to finish a submitted operation | Existing journal/reconciliation remains authoritative; do not reinterpret process exit as settlement | Quiesce writers before production replacement. Interrupted or ambiguous operations remain unresolved; no dispatch or executor-lease semantics changed here. |

## Startup and shutdown sequence

Configuration and the hosted registry are validated before serving. Existing reservations are reused;
one supervised child is started per configured managed name. Children still acquire their executor
lease before activation. External loopback agents without `envFile` are not supervised or terminated.
Gateway `/health` remains process liveness, not child readiness, provider availability or settlement.
Cold ownership reads refuse until evidence is available; there is no new readiness endpoint.

On SIGINT/SIGTERM, the gateway marks itself stopping, closes its listener, rejects further requests
on retained connections and prevents post-await setup reservations/RPC forwarding. It cancels restart
timers and signals its own children. The supervisor waits up to 30 seconds, then sends SIGKILL and
waits up to five more seconds. Forced/unconfirmed shutdown exits nonzero. HTTP connections are closed
at 30 seconds. A child shutdown may interrupt work; no submission is replayed by the gateway.
Deployment grace must exceed this 35-second bound with operational margin; verify it in the owner’s
maintenance window. Runtime evidence, not a health response, determines whether replacement is safe.

The supervisor waits for direct child `close`. It is not a
general OS process-tree supervisor. An externally killed gateway, machine failure, detached descendant
or unkillable process still requires the stopped-writer checks in operations. No automatic failover
to another host is introduced.

## Boundary coverage

| Boundary | Evidence reused or extended | Explicit limit |
| --- | --- | --- |
| Actual Host, sign-in audience, per-agent permissions | `demo-hosts`, `gateway-session`, `gateway-denial`, `gateway-access`, `shared-discovery` tests | Warm verified agent ownership can survive a failed refresh; cold unknown ownership denies. DAO permission reads remain separate. |
| Supplier sessions and exact routing | `hosted-gateway`, `static-supplier-route`, `invoice-proxy` tests; independent Payables browser contract | Supplier wallet sign-in and an existing live work-order journey remain unverified. |
| Child credentials and owner binding | `hosted-agents`, `hosted-binding`, `hosted-gateway` tests | Hosted children share the UID/filesystem and infrastructure API credentials. Static configured children retain their existing broader environment inheritance. |
| Durable reservations | `hosted-agents` now includes orphan settings after an interrupted reservation | Orphans refuse automatic replacement; missing whole-volume state cannot be reconstructed from this registry. Capacity remains 32 reservations. |
| Executor ownership / startup | `executor-lifecycle`, `executor-lease`, `executor-creation`, plus supervisor tests | Single host only; no distributed lease fencing or safe multi-replica claim. |
| Ambiguous invoice and operation outcomes | Existing SQLite crash/concurrency, journal, replay and recovery tests | Provider terminal status is not independently proven nonpayment; see enforcement. |
| Transport loss and cancellation | RPC and supplier timeout tests; forwarding disconnect handlers | Cancellation ends the connection, not an accepted operation. No redirect following or automatic mutation retries. |

## Repository and interface ownership

Proto owns shared hosting, authorization routing, provisioning, process supervision, durable execution
infrastructure and compatibility tests. Treasury owns its product frontend; Payables owns payment,
work-order and supplier product behavior. Invoices is a runtime responsibility, not another repository.
Sibling repositories still contain standalone backend copies; this review does not make them a shared
library or authoritative source for Proto’s deployed backend. Port necessary fixes explicitly, with
separate review and consumer tests; never deploy a sibling server configuration over Proto.

`gateway-boundaries.test.ts` rejects direct runtime imports of executor handlers or external sibling
source from the gateway. Existing `send-path` tests retain the single dispatch site. Type-only router
imports are allowed. This is a bounded dependency check, not proof against arbitrary dynamic loading.

The existing [frontend integration contract](../shared-frontend-integration.md) remains authoritative:
`/gw/me` advertises explicit `setupAreas`; `/gw/agents` reserves local setup without signing; scoped
oRPC uses `/a/<instance>/rpc/`; unknown procedures deny by default; selected-agent supplier links are
authoritative and missing mappings never fall back to another owner. Exact work-order identity and
query parameters survive navigation and reload. There are no new routes or persisted record versions.

**Error compatibility change:** explicitly constructed ORPCErrors retain their code/message. Reviewed
`PublicError` messages become BAD_REQUEST; hosted owner-binding guidance uses this type. Other plain
exceptions now become INTERNAL_SERVER_ERROR with fixed uncertainty guidance, rather than BAD_REQUEST
with arbitrary text. Provider errors retain their code and validated refusal metadata but not raw
title/detail. Consumers must branch on structured codes, not exception prose, and never infer that
an unsuccessful HTTP response means an action was not accepted. Existing domain errors not explicitly
classified as public now receive generic guidance. This reduces diagnostic detail deliberately; add
reviewed public messages at their origin when a specific workflow needs them, never a catch-all echo.
No raw exception logging was added. Existing private diagnostic logs still require restricted handling.

## Source and deployment provenance

Read-only `git ls-remote` confirmed remote main at
`98b912a13da81eec05c130a46f7f138164b43b77`, matching the clean initial checkout. No commit or push
was needed to close the prior integration handoff; this review's changes remain a separate local diff.

The frozen archive SHA-256 was rechecked as
`0add241b3d4d645627f1ed2bbb48666fbb3c5cf48f75776f204230faa0577e4e`; all 220 review-manifest
entries matched. Of 197 original manifest entries, 113 match their paths in that commit, one
(`Dockerfile`) is the packaging substitution matching committed `deploy/Dockerfile.shared-frontends`,
and 83 are generated Proto/sibling assets absent from Git. Therefore the commit is the captured source
baseline, not a byte-for-byte deployed tree. The execution record connects the frozen runtime to
deployment `09bf2aa6-d805-400a-97a8-7e55b7f131fa`, image
`sha256:95ceea0c37486922c2946f6a39fc5e5528af8c7c0132dd16e8fcdf2bb3a8d4d8`, through 195 runtime
hash checks. Those deployed checks were reused, not repeated against production.

Current sibling `web/dist` trees differ from the frozen assets; their new compatibility checks do
not recertify the old archive or authorize packaging. Keep release artifacts, backups and secrets
outside tracked source. No new release artifact is needed for this review.

## Validation of this local change

- `pnpm typecheck`: passed.
- Full offline runner (`node scripts/test.mjs offline`, the runner behind `pnpm test`): 755 passed,
  zero failures. It includes real child-process, SQLite, HTTP and fault tests with external network
  access blocked. The original release's 743-test result is separate evidence.
- `pnpm evidence:check`, `pnpm build:web`, and `git diff --check`: passed.
- Independent current Treasury and Payables builds each passed `scripts/test-shared-frontend.mjs`
  against this changed Proto runtime, sequentially after the offline suite. No sibling sources or
  builds were changed by these checks. Wallet, provider and work-order observations are fixtures;
  these are not hosted authentication or payment observations.
- The initial sandbox could not open loopback/tsx IPC sockets. Those checks were rerun outside the
  filesystem sandbox with their offline network guard retained; sandbox failures are not counted
  as passing evidence. The only remote read in this implementation was Git branch provenance.

No commit, push, packaging cycle, production deployment, restart, credential rotation, grant or
money action was performed. The existing production artifact and its evidence remain unchanged.


## Follow-up review (2026-10-16)

- **High, lifecycle — Proto:** a real tsx launcher reproduction left its worker alive after forced
  shutdown. Gateway children now use Node with the tsx import loader directly. The real-process
  regression verifies the supervised PID equals the application PID and no longer exists after kill.
- **High, transport — Proto:** the first 30-second RPC idle limit interrupted ordinary silent
  settlement waits (180 seconds per leg). The limit is now fifteen minutes, with delayed-response
  and stalled-response tests. Longer operations can still disconnect; records remain authoritative,
  and no retry is introduced. This is a bounded transport allowance, not a settlement guarantee.
- **Medium, recovery — Proto:** generic error masking also hid reviewed owner/strategy guidance.
  Selected literal domain messages now use PublicError; unexpected and dynamic exceptions remain
  opaque. Offline RPC tests verify both guidance and secret suppression.
- **High, credential boundary — Proto:** custom RPC hosts previously inherited the FastNear bearer.
  Credentials now require an exact trusted HTTPS host; REST redirects are rejected. Host-confusion
  tests cover custom hosts, suffix attacks, plaintext, userinfo and nonstandard ports.
- **Medium, availability — Proto:** indexed transfer and signature scans now reject repeated cursors,
  more than 100 pages, or a two-minute deadline. No partial result establishes absence of evidence.
- **Explicit limitation:** deposit lookup batching remains deferred. The published Transactions
  OpenAPI specifies up to 20 hashes but leaves transaction objects unspecified; the reviewed
  explorer API source returns raw database objects without preserving input order. Existing
  single-hash reads retain their identity guarantee until a pinned raw-object schema or sanitized
  real response establishes hash mapping. No positional batching assumption was introduced.
- A read-only status script reports sanitized numeric indexer lag/height and request latency.
  Deployed health availability and response shape remain unverified. Confidential custody and
  settlement still require provider evidence; public indexer health does not establish either.

Sources checked: https://docs.fastnear.com/openapi/transactions.json and
https://github.com/fastnear/explorer-api (api.rs and click.rs). These source observations are not
claims about the deployed provider version. No release artifact, state migration or production
mutation was performed.

Follow-up validation: typecheck, 763 offline tests and evidence consistency passed.
Independent existing Treasury and Payables frontend builds also passed their gateway browser
contracts sequentially. No consumer source copies or new release package were introduced.

The [Effect v4 adoption](effect-supervisor-trial.md) promotes the tested scoped supervisor into
Proto after the owner chose adoption. Consumer contracts and the money path remain unchanged
by this promotion. A fault test additionally covers signaling failures without false clean shutdown.

Effect promotion validation: 767 offline tests, typecheck, evidence consistency, Treasury browser
contract and frozen r2 Payables browser contract passed. The current Payables build introduces
`compensation/list`, which the shared fixture does not recognize; its compatibility remains open
and must be reviewed separately before releasing that consumer build.


## FastNear Effect read adoption

The read facade now uses an injected HTTP service, typed failures and Effect-owned deadlines and
concurrency. Reproduction: a malformed DAO `/account` response `{}` previously produced no signature
instead of unavailable evidence. The new regression failed before schema validation and passes
with explicit rejection. Verification of candidate signatures is unchanged. Additional faults cover
pre-aborted callers, body stalls, an overall deadline across pages and cancellation of queued and
active reads. The first cancellation test exposed an extra fetch for an already-aborted caller;
the Promise boundary now checks that condition before starting the Effect runtime.

Proto owns these changes. Public Promise interfaces and consumer RPC contracts are preserved;
optional AbortSignal parameters are additive. No retry, persistent cache, deposit-batch identity
assumption, money submission change or state migration is introduced. Separate Agent API reads
are outside this timeout migration. See the architecture's FastNear read-lifetime section for
limits and tests.

FastNear migration validation: typecheck, evidence consistency and all 773 offline tests passed.
Existing consumer browser evidence is reused because public RPC/Promise shapes and frontend
source are unchanged. The previously recorded current-Payables compensation contract gap remains
open; this read migration does not establish compatibility for that consumer feature.
