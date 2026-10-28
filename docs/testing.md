# Test boundaries and verification

`pnpm verify` runs type checking, the offline Node suites, the production web build and offline
browser suites, the offline application E2E suites, then generated-evidence drift checks. It does not run live verification. Live checks
remain explicit and owner-authorized; passing fixtures does not establish deployed behavior.

## What earns a test

Each case must identify an important regression and assert its observable consequence. A failure
fixture must establish that the failing request or fault boundary was reached. Assertions over a
collection must establish that the intended controls or records exist; an empty selection is not a pass.

Keep exhaustive input and state combinations in the lowest layer that can prove them. Browser cases
own interaction, focus, rendering and query/cache wiring; E2E cases own real service, storage and
signing integration. Repeating a rule at another layer is justified only when it checks that layer's
distinct wiring or boundary. Preserve real-process crash, locking and restart cases.

Before adding a case, check its task suite for an existing stronger scenario. Extend that scenario
when it owns the same regression. Do not keep an extra browser journey for an assertion already made
there, or multiply behavior by viewport when resizing the resulting state proves the layout requirement.
Close scenario contexts and fail on unexpected browser errors. Test counts and file counts are not
coverage targets; the failure each case detects is the reason to keep it.

Wait for an observable state or response instead of sleeping to guess when it is ready. Use deferred
responses for pending-state checks and the browser clock for timer-driven behavior. A real-time wait
must exercise a timing requirement, not compensate for an unknown loading sequence. The shared browser
harness fails on uncaught page errors and route-fixture exceptions, including those in popups.
Checks that polling stopped must advance beyond the longest applicable interval. Checks that a
refresh preserves a draft or focus must first prove the refresh happened; elapsed time alone is not evidence.

## Offline Node tests

`pnpm test` uses `scripts/test.mjs offline`. Discovery excludes the two registered live suites rather
than relying on missing credentials to skip them. The launcher retains basic operating-system
variables, supplies `test/offline.env`, and discards inherited application settings, credentials,
proxies and Node preloads. Its network preload blocks non-loopback Node TCP connections and fetches,
including in Node fixture subprocesses that inherit the environment. Local HTTP servers, Unix sockets,
real SQLite, files and crash/concurrency processes remain available.
For a targeted run, use `pnpm test test/source-analysis.test.ts`; explicit selections cannot include
live suites or files outside the registered offline tests.

This is a test-process guard, not an operating-system network sandbox. Do not introduce native
network clients or subprocesses that discard the guard without adding isolation checks. Per-test
provider mocks remain necessary to state exactly which observations and submissions are expected.

`freshDirectory` gives suites isolated state and removes the directories it owns after the suite.
Suites that leave their working directory unchanged use `temporaryDirectories` and register its
cleanup after child-process and server teardown. Fixture subprocesses need bounded execution and
exit diagnostics; intentional crash cases must assert their expected crash status.
Fixture builders provide valid starting evidence; scenario overrides must remain visible. Do not
repair missing identity, synchronization, freshness or authorization evidence behind a test's back.

Source-boundary checks parse TypeScript/TSX, including runtime re-exports and literal dynamic imports.
They reject non-literal module loading in inspected dependency graphs and constrain grant-factory
uses outside dispatch to direct, explicit dry quotes. These are structural regression checks, not a
proof against arbitrary program transformations. Money-path behavior is also tested with submission
counters, journals and real crash/restart fixtures.

## Offline browsers

Install the pinned Chromium with `pnpm exec playwright install chromium`, then run
`pnpm test:browser`. To repeat selected suites against an existing build, use
`node test/browser/run.cjs live-demo.cjs` (substitute the desired suite names).

Proto's suites cover its own pages: sign-in and the public entry (`showcase.cjs`, `public-overview.cjs`), setup and
onboarding (`setup.cjs`, `first-owner.cjs`, `walkthrough-entry.cjs`), walkthroughs and the rehearsal
(`live-demo.cjs`, `signing-walkthrough.cjs`, `payables-player.cjs`), the redirect map (`app-redirects.cjs`), agent
access (`agent-access.cjs`), demo hosts (`demo-hosts.cjs`) and the payee pages Proto serves (`invoices.cjs`, `hosted-payee.cjs`, `work-orders.cjs`).
The agents' operational screens and their suites (payments, funding, policy, strategy, runs, recovery and Activity)
are in the Payables and Treasury repositories. A new test belongs beside its task, in the repository that serves it.

Merged suites share one browser and close all contexts between scenario groups. The layout helper resizes an already
loaded state at 320, 390 and 1280 pixels. New coverage adds extra viewports only when the interaction or layout depends
on width.

The shared browser fixture blocks service workers, unhandled requests and WebSockets. Scenario routes
provide explicit responses; the shared RPC dispatcher rejects undeclared procedures, including writes.
An explicitly declared `undefined` remains valid for a void procedure. A fixture-handler error fails
the process even if the application or scenario catches the resulting request error.

Each run creates `.test-artifacts/browser/run-*/manifest.json` and `results.json`, with the Node version,
asset/source/fixture/lockfile hashes, suite results and durations. Successful suites discard their
traces. Failed suites retain available traces, screenshots and fixture errors; the runner also keeps
its captured source, fixtures and built assets. A hard process timeout may prevent trace finalization.
Artifacts are ignored by Git. The hashes identify what was tested; they do not prove that an existing
build was generated from the current source. Use `pnpm test:browser` to rebuild before verification.

The browser fixtures are UI integration tests with simulated transport. They do not run the deployed
gateway or provider, and their passing results do not establish live authorization or settlement.
Some intentionally partial response fixtures remain scenario-local; the strict dispatcher checks
procedure ownership, not every response's runtime schema.

## Offline application E2E

`pnpm test:e2e` snapshots source and builds it in an isolated artifact directory. It runs the real
gateway, approve-only agent, payout executor and invoice listener against loopback provider/chain
fixtures and an injected test wallet. Application RPC and invoice responses are not intercepted.
The Node network guard and browser request allowlist exclude external services. Its fixture keys,
sessions, SQLite stores and logs belong only to the test environment. It exercises approval versus
settlement, retained invoice identities, restart recovery after an accepted transfer loses its response,
lost owner-signature response recovery, and approve-only refusal. It does not establish real provider,
chain or wallet behavior.

A plain run is the whole suite: if any case skips (a missing app release build, Treasury skill or change name), the run
fails and names the skipped cases. `--narrow` marks a deliberately partial run and is not whole-suite evidence;
`pnpm verify` passes it because it has no app release builds. Whole-suite evidence is a release-candidate run with every
release input (`--invoices-dist-release/-next`, `--payables-dist/-next`, `--treasury-dist/-next`, `--treasury-skill`).

Each run records a fingerprint of the installed dependency tree (`scripts/dependency-tree.mjs`: pnpm's installed
lockfile and every installed package directory); `node_modules` is shared, not copied. A run from a frozen snapshot whose
`SNAPSHOT.json` names a fingerprint refuses to start against a different tree, and any run fails if the tree changes while
it runs. Each run also retains source/build/lockfile hashes, Playwright results, traces, screenshots, service logs
and database observations under `.test-artifacts/e2e/`. `pnpm verify` includes this suite once;
its isolated build is separate from the UI fixture build. Both must come from the same fixed revision.

### E2E boundaries and agent-browser exploration

The SDK calls a local HTTP provider simulator; a local NEAR RPC fixture supplies owner classification
and test-key membership. Each case uses fresh storage, a fresh agent identity and a test grant.
The approve-only instance also receives a valid local grant: its refusal must come from executor
enforcement, rather than a missing credential masking a broken guard.
The runner requires OpenSSL on PATH and the installed Playwright Chromium browser.
Two HTTPS origins exercise cookie separation and same-origin writes. Certificates are self-signed
and trusted by the test browser only; this does not test deployed certificate trust or proxy configuration.

The wallet adapter uses near-connect's injected-wallet interface and real NEP-413 signatures from
an unfunded fixture key. The invoice page's CDN connector import is served from the installed package,
and external wallet manifests are replaced with an empty list. Application sign-in challenges,
signature verification, session cookies, permissions, dispatch, owner-intent records and invoice
SQLite transactions run unchanged. This does not verify a real wallet extension, NEP-366 signing,
a DAO vote, provider enforcement, or actual settlement.

The initial cases cover:

- An invoice becoming held, wallet approval through the approve-only dashboard, a distinct processing
  outcome, simulated settlement, reservation release, and record preservation across executor restart.
- A transfer accepted by the simulator with its response dropped: uncertainty and reservation survive
  restart; repeating the same identity does not resend; editing the retained draft requires review;
  a new identity remains blocked; the approve-only instance refuses a money action.
- An owner signature accepted with its response dropped and outcome evidence withheld through reviewer
  restart: the durable action remains submitted, the page warns against signing again, and neither
  the wallet nor provider receives another signature submission. Restoring evidence records approval;
  settlement remains separate until the simulator reports success.
- A retained submission's uncertainty warning stays beside the form after reload. This frontend
  regression was found through agent-browser exploration of the same stack. Draft memory is not
  evidence of a provider outcome, and the notice says so without claiming the payment failed.
- Work orders (`work-orders.spec.mjs`): a purchase order and an isolated contribution-report payout each
  run owner-signed agent creation, an invoice grant expiring at the order deadline, a deposit address,
  simulated funding one unit short (payee filing refused, no transfer) then exact, payee filing,
  a held payout from the created agent only, owner approval (still not paid), and simulated settlement.
  Filing again after payment sends nothing. A third case rejects the held payout: nothing settles and
  filing again sends nothing new. Owner steps use the gateway RPC with a locally signed NEP-413 payload.
- New-prototype example (`minimal-prototype.spec.mjs`): `examples/minimal-prototype/`, built with rsbuild against
  `@multiagency/sdk` and served as the `showcase` host's `frontendDist`, signs in through the gateway, reads `overview`,
  and pauses and resumes the agent through owner-signed `agent_freeze`/`agent_unfreeze` (two wallet signatures, two
  submissions). Signed-out scoped calls are refused with 401; no transfer occurs. A second case loses the preparation's
  reply (no signature is asked for), then a submission's reply with record reads failing until a reload: the reloaded
  page follows the kept `correlationId` to the recorded outcome, with one signature and one submission.

The tests compare browser output with read-only SQLite queries, durable owner-intent records and an
independent simulator request log. Restarts here are controlled process restarts after a lost response,
not abrupt termination during a submission. Existing child-process fault tests retain their separate
crash coverage. The simulator deliberately does not deduplicate submissions: any second submission
is observable and fails the test. Its behavior is authored test evidence, not a provider specification.
The simulator keeps per-agent policy, grants and funding: owner-signed `agent_create` creates an agent
with the signed policy, `grant_issue` adds a grant to the named agent, and transfers must present a live
grant's token, match a policy destination and stay within the per-transaction limit and funded balance.
Owner-signed `agent_freeze`/`agent_unfreeze` set the agent's policy `frozen` flag.

Shared builder payouts (`test/e2e/shared-payout.spec.mjs`): one-time setup as owner steps (a signed policy update that
adds the builder; funding the payout agent), then a report paid once from the shared balance with one held approval
and recorded settlement; before funding, the send is refused and the payment stays prepared on its identity. A lost
send response leaves the payment unknown (no operation id to read): it is never sent again, and the payout agent's
later sends are blocked until it is reviewed.

App access (`test/e2e/app-access.spec.mjs`): an app deployment's server (the dashboard's, as the first app) on the real stack, using the
published oRPC client. The operator CLI issues its service credential; the owner signs a consent with the simulated
wallet; overview is read; freeze, unfreeze, a payee added to a non-empty list and a budget edit are each prepared through
`/apps/v1`, signed and submitted. Payees at creation and DAO signing are refused before any intent is generated. A
provider-enforced edit (`owner_approval` off) is made NEP-366 by the simulator: the app receives only a confirm link;
reading it gives the app the terms but not the bytes, and its own `owner/submit` is refused. In a browser the page
shows the field before and after, the simulated wallet signs the link's text and then the delegate, the policy
changes, and the log records `confirm` then `confirmed`. A signed
setup reserves the Organization's own payables agent beside the owner's configured one, its creation is relayed
under the setup consent, and a consent naming the created agent's ID then relays a grant. Here the simulator signs
provider-enforced policy edits as NEP-366 (`onChainPolicyEdits`), following the provider's docs, not observation. A second
case requests payouts through the app's `payout` consent on the Organization's own hosted agent (its grant and payee
signed by the owner through the app, its funding simulated; policy edits stay NEP-413 in that environment): one request is held for the owner, asked again and read by `requestId` without a second send, other
terms under its `requestId` are refused, a second request with the same payee and amount while the first is held is
refused before sending, the owner's vote on the held one is relayed by the app (prepared with the terms the platform
proved, signed by the simulated wallet) and the payout reads `succeeded` once the simulator settles it, with nothing
sent again, and a lost reply reads `unknown`, is never resent and blocks new requests.

Owner contract conformance (`test/e2e/conformance.mjs`): in the Payables, Treasury, work-order and example specs, every
owner RPC answer the page receives, including each streamed event, is decoded with oRPC's serializer and must parse
against its published schema (`src/contract/owner-outputs.ts`) and deep-equal the decoded value, so a stripped field
fails. Each case writes `conformance.json`. Reads are also validated on the server (`src/rpc/read-output.ts`, validate
only); mutations and streams are not, so a completed action is never reported as failed.
A rejected held payout ending `FAILED` with no movement is an assumption, not observed provider behaviour.

SDK guidance (`pnpm contract:skills`, after `pnpm contract:pack`): installs the packed `@multiagency/sdk` tarball in an
isolated npm consumer, typechecks every `ts` fence of the shipped `skills/*/SKILL.md` (strict NodeNext, no Node types),
runs each example against stand-in servers (an oRPC owner agent and a payee entry) asserting what is sent and how often
(a lost read is read again once; a lost submit, stream or report is read by its kept identity, never resent), then runs
`intent validate` with the unpublished `_artifacts`, `intent list` and `intent load`. It needs the npm registry.

The runner sanitizes its environment and installs the offline Node network guard in application
children; browser routing blocks unexpected external requests and WebSockets. Unknown simulator
requests fail the suite even when the app catches the response error. This is process-level isolation,
not an operating-system network sandbox. Do not supply live secrets to these workflows.

Results live under `.test-artifacts/e2e/run-*`: the source/build snapshot, manifest, Playwright results,
traces, screenshots, process logs, simulator requests and retained storage. The manifest identifies
source, assets, evidence, tests, lockfile and tool versions; Chromium's version is recorded with each
case. Retries are disabled. Traces from the original attempt are retained even on success. These
artifacts contain only fictional local data but should remain untracked.

`pnpm test:e2e:explore` builds the same isolated stack and keeps Chromium open for agent-browser.
Its `exploration/session.json` prints the loopback CDP endpoint, application URLs, and fixture account.
Attach with `agent-browser --session proto-e2e --cdp <endpoint> snapshot -i`, then use ordinary browser
actions. Pass `--owner` to explore as the wallet owner. This adapter cannot submit chain transactions.
Create `exploration/drop-response` to drop the next simulator transfer response; create
`exploration/stop` to capture the final trace and stop the local processes. These controls are files
outside the application, not test-control HTTP routes. Close the agent-browser session afterward.

`pnpm test:e2e:stack` (optionally with `--invoices-dist-release <dir>`, `--owner <account>`, repeated
`--payee <account>`, `--frontend <dir>` to serve a prototype build on the `showcase` host, `--payables-release <dir>` to serve a
Payables build at `/a/payout/`, `--builder <account>` for an account on chain that is not yet an agreed payee (the
owner adds it with a signed `policy_update`, which the simulator applies and versions), `--payout-funding <raw USDC>`
for the payout agent's starting balance, `--treasury` to add the Treasury agent `portfolio` (owned by the payee
account, 100 simulated USDC; its owner issues machine credentials at `/a/portfolio/access`), `--headed` or `--no-browser`) builds the same isolated stack for app-owned workflow
recipes and filming, and keeps it running. `stack/state.json` lists the application URLs, CDP endpoint,
owner and payee wallet contexts (the owner's starts signed in on `/a/payout/`), with `--treasury` the portfolio's access page and
machine base, the payout policy and revision, created agents, deposits, simulated transfers and invoice records,
refreshed every 250 ms. Write `stack/controls/<name>.json` with a `command` of `fund`, `fundPayout`, `settle`,
`dropTransferResponse`, `dropSignatureResponse`, `revealOwnerOutcome` or `setUnavailable`; its result
appears as `<name>.result.json`. Create `stack/stop` to stop. An attached client signs in from the stack's own wallet
pages: a page it opens itself has no local test wallet, and its own CDP connection must accept the local certificate. Signatures, deposits and settlement are simulated.
Page dialogs (such as the payee's filing `confirm()`) are logged in `state.json` `dialogs` and left open
for the attached client or person to answer; an attached Playwright client must register its own dialog
handler, or it dismisses the dialog itself. `--accept-dialog '<exact message>'` (repeatable) instead accepts
only a confirm with that exact text, and logs it as accepted.

This suite does not cover all DAO roles, scheduled tick execution, arbitrary provider outages,
or production canaries end to end. Existing narrower tests cover parts of those behaviors; they must
not be counted as full-stack production observations. Deployed verification and money actions remain
separately owner-run.

### Challenging the E2E assertions

`pnpm test:e2e:challenge` first discovers the complete baseline from its isolated source and requires
every discovered case to pass once without skips or retries. The retained `baseline-list.json` is
matched against the results by case and project identity, so added cases cannot silently be omitted.
It then creates three separate disposable copies of that tested snapshot and deliberately introduces
one fault into each: duplicate transfer submission, a premature Paid invoice label, or removal of the
approve-only dispatch guard. It rebuilds each copy and runs the relevant journey. Working application
files and the baseline snapshot are not edited. This optional command is separate from `pnpm verify`.

A challenge counts as detected only when the named assertion fails and independent simulator/storage
evidence confirms that fault was exercised. Build failures, timeouts, unexpected simulator errors,
skips, and unrelated test failures do not count as detections. The command fails if any fault survives
or the experiment is invalid. Exact mutation anchors must match once; changed source requires review
of the experiment rather than silently choosing another edit.

The run retains `challenge-results.json` plus each fault's `mutation.json` with source hashes, mutated
snapshot, build/test logs, Playwright report and ordinary E2E evidence. These experiments demonstrate
sensitivity to these three particular regressions; they are not exhaustive mutation coverage or
evidence of production correctness.

## Explicit live verification

`pnpm test:live` requires `NEARAI_API_KEY`, `NEAR_INTENTS_AGENT_API_KEY`, `AGENT_ID` and
`AGENT_GRANT_TOKEN` from the configured environment/settings. Missing configuration fails before
tests start. Live files refuse direct execution outside the live launcher and no longer silently skip.

The attestation cases contact NEAR AI Cloud. Plan-refusal cases read current account/provider evidence
and request dry quotes. A test-owned fetch barrier, loaded before the SDK, permits Agent API reads
and exact `dry: true` swap requests, and refuses other Agent API writes before transport. Blocked
attempts fail the process even if their errors are caught. Empty-operation-log assertions remain as
an additional check. The barrier is tested offline against the actual SDK and a fake transport.

These cases do not verify successful money submission or settlement. Any future test intended to
submit requires a separately named, explicitly authorized workflow; do not disable this barrier to
make a refusal test pass. Test results describe the observed run, not the identity of a future provider
deployment. Deployed smoke checks and recorded mainnet observations retain their separate scopes.


## Candidate and deployed verification

`pnpm release:candidate -- <inputs>` (scripts/release-candidate.mjs) produces a release candidate in one command,
from a commit (`--ref`, default `HEAD`). It takes the same app inputs as a plain `test/e2e/run.mjs` and requires all of
them: Invoices H and I, Payables A and B with B's change, Treasury A and B with B's change, and the Treasury skill.
Uncommitted changes are not included; commit first.

1. Freeze: `git archive` of the commit into `.test-artifacts/stack-snapshots/`. `node_modules` is shared and its
   dependency tree is recorded.
2. Gates, in order, stopping at the first failure. Nothing is packaged after a failure; logs and `RELEASE-FAILED.json`
   stay in the snapshot.
   - typecheck, the offline suite and `evidence:check`;
   - one frontend build, then the browser suite, the full E2E run and the challenge run, all against that build. The
     E2E runs use `--prebuilt-web`, so they test the frozen build instead of rebuilding it; a rebuild isn't
     byte-reproducible. The command refuses if an E2E manifest's `assets` differs from the candidate's build.
3. The snapshot is renamed to its run digest, which is the name app recipes use. With `--sdk`, the SDK is packed from it
   and its skills are checked.
4. The deploy sources go to `.test-artifacts/releases/<runDigest>/`: the dao package
   (`scripts/package-shared-frontends.mjs` with the shipped Payables and Treasury releases, B) and the invoices source.
   `release.json` records the commit, every input digest, the frontend source and build digests, each gate's command,
   status and counts (E2E run ids and stats, challenge outcomes, browser scenarios), and the package digests.

It deploys nothing, uses no credentials and touches no state directory. Deploying from those sources stays the owner's
action.

The workspace E2E cases use a separate Portfolio executor, provider identity and store alongside the
Payables executor and approve-only server. They cover full-document cross-agent navigation and back,
wallet ownership per agent despite ignored legacy operator configuration, forbidden direct reads and settings writes, strategy save with the
schedule off, stale save/authorization/enable refusal, actual local grant signing, explicit enablement,
and stopping after a declared provider outage. Database/provider records and persisted settings support
browser assertions. They do not establish DAO role coverage or scheduled money execution end to end.

Before calling a candidate deployed-verified, complete this checklist in a private release record:

1. Record the candidate source hash and full pipeline results. Resolve the other review session's
   findings; any source change needs a new candidate. Match the final commit/source archive to the
   tested files. Follow the existing [owner-run rollout](operations.md#owner-run-rollout).
2. Record UTC time, deployment ID and source/image identity separately for `dao` and `invoices`.
   Obtain these from deployment records; `/health` and asset names alone do not identify source.
   Establish that both services use the reviewed candidate. An unknown deployed revision remains unknown.
3. Run `DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke`.
   Without an authenticated session this covers public health, headers and access boundaries only.
4. In an authenticated browser, inspect existing Payments, Agreements, Strategy, Runs and Activity.
   Check cross-agent navigation/back/reload, retained recovery wording, owner decision versus payment
   outcome, and keyboard/mobile layouts at 320, 390 and 1280 pixels. Record empty views and unavailable
   evidence as such. Do not populate views by creating invoices, approving payments or starting runs.
   Some page reads refresh retained observations; view-only inspection is not a storage-immutability claim.
5. Keep screenshots and account/payment details in restricted private artifacts, separate from offline
   fictional fixtures. Record failures and authentication blockers; a local mock cannot replace a hosted
   observation. Do not export cookies to enable browser access.
6. Money verification is a separate owner-authorized operation. Retain its reviewed policy/strategy
   binding, operation identity, provider correlation, owner action where required, terminal provider
   outcome and durable records. Approval is not settlement. Unknown outcomes remain unresolved; never
   retry with a new identity merely to obtain a passing result. Do not test crash/restart faults live.
