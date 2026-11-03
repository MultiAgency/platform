# Operations

The 2026-10-16 four-domain release is recorded in [archive/](archive/) (the
[execution record](archive/proto-release-execution.md) and [release review](archive/proto-release-review.md)).
Future production changes require their own authorization and must preserve executor assignments
and all four volumes. No deployment or restart is implied by committing source changes.


These instructions describe the repository configuration. Deploys, restarts and money actions are
performed by the owner. For the product and recorded results, see [README](../README.md).

Preserve the complete state when moving an executor. This is the canonical list; AGENTS.md and
`scripts/check-shared-image.mjs` repeat it, and `test/state-directories.test.ts` keeps them equal:
<!-- state-directories -->
`.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/`, `.hosted/`, `.agent-connections/`, `.machine-auth/`, `.app-access/`, `.proposals/`, and any legacy `.intake/` files
<!-- /state-directories -->
plus each instance's settings file. `.ops/` also holds each executor's `<agent>.submission-evidence.ndjson` (provider answers to failed sends; evidence only, never read to decide a send). `.invoices/` includes its SQLite journals and the compensation store
(`<agent>.compensation.sqlite`); `.notify/` records which alerts were sent (losing it re-sends them); `.agent-connections/`
holds agent connections and their access log (see [agent access](agent-access.md)); `.machine-auth/` holds Treasury
machine credentials; `.app-access/` holds app service credentials (hashed), owner consents, revocation tombstones (`revoked/`,
never delete: losing one lets that consent be stored again), held confirm-page actions (`confirm/`, one record per link,
named by its token's hash, and a `.claim` file once a submission was made; an older build ignores them) and the access log; run `pnpm app-credential check-keys`
on a schedule so a removed owner key ends its consents even when no call observes it. Consents belong to the deployment
name: a credential issued under an existing deployment name acts on all of its consents, so use a new name for an
app that shouldn't inherit them; `.hosted/` the hosted agent registry; `.proposals/` holds Treasury proposals (each proposal, the
owner's approval, and one final record: claimed for execution with its plan, or closed; never delete: a lost final record
lets an approved proposal execute again; an older build ignores the directory, and its open proposals wait unexecuted). Stop writers before copying state; never start the destination before stopping the
source. The lease coordinates processes on one host only.

## Work-order executors

Work-order support is locally implemented and offline-tested, not deployed or mainnet-observed.
The payout executor hosts one private subprocess per opened order; the dashboard accesses it using
the existing `AGREEMENTS_URL` and `AGREEMENTS_SECRET`. The bridge also verifies the configured parent
agent ID. An approve-only process never substitutes itself if that bridge is missing or unavailable.
The invoice host authenticates the payee and routes only to that payee's recorded work order.

The additive version-1 records live in `.work-orders/<parent-agent>/<order-id>.json`. Each immutable
record has a companion `work-<parent-hash>-<order-id>.env` and `.initialized` marker. Preserve all
three with the corresponding `.owner-intents/<settings-basename>.json` and the child agent's state
in the directories listed above. The invoice container's working directory is the `/data` volume.
No existing-record conversion is required. Stop the parent and its children before backup, migration
or rollout; preserve corrupt records for investigation rather than replacing identities. A missing
initialized settings file refuses recovery.

On restart, retained agent and owner-action records resume their own subprocesses. Failed creation,
attempted signatures and uncertain payments retain their original identity; no automatic replacement
is created. Existing owner-intent and invoice recovery rules apply. The pre-creation instance lock
has a 30-second stale threshold, followed by the existing per-agent executor lease once created.
This coordinates processes on one host only, not across hosts or volumes.

`MAX_WORK_ORDER_EXECUTORS` defaults to 8 and accepts 1–64. Open subprocesses remain active for the
parent's lifetime; reaching capacity refuses another start without substituting the shared payout
agent. Review capacity before rollout. Automatic process retirement, archival and residual-fund
return are not implemented. Revoking the grant stops new work but cannot undo an accepted payment.

## Settings and record-read hardening

Settings updates now lock the canonical settings-file target before reading and replacing it.
Symlink aliases share that lock. A competing update returns a retry error without changing settings;
retry the action after the current writer completes. This is single-host coordination, not distributed
fencing. A CLI edit does not refresh another running process's environment. After a writer crash,
the settings lock must age past its 60-second stale threshold; never delete a live writer's lock.

Before upgrading, stop all writers, including CLI processes using the same settings file. Old writers
do not participate in this lock. Preserve the full state listed above and the settings files. The saved
formats are unchanged, so there is no record conversion. Offline child-process tests cover competing
settings updates, retry, and symlink aliases; this is not a mainnet observation.

Inbox and agreement readers reject damaged records, including a torn final append, rather than hide
them. Unreadable inbox history defers scheduled ticks and logs an error without crashing the server.
The peer owner-intent scan similarly refuses a new DAO delegate when the fields needed to check
pending actions cannot be read. Preserve the damaged file, stop writers before repair, and restore
only from verified records. Do not delete evidence merely to resume a schedule or prepare an action.
Manual ticks and operation-journal authorization retain their existing behavior.

Own and peer owner-intent readers now reject malformed or contradictory lifecycle records. A missing
stage is compatible only with an unsigned legacy preparation; a retained signature must never be
converted back to a first submission. Keep the original file intact, stop writers, and investigate
against verified outcome evidence. This is validation of existing records, not a format conversion.
Onboarding now acquires the executor lease and starts its background loops without a restart. If
ownership is unavailable, recover the original creation action after resolving executor ownership;
do not create another agent or submit the signature again.
The cumulative autopilot ceiling reads existing per-operation `planId` and `usdIn` records; it adds no
counter or state conversion. Preserve those records with the full state above. Missing valuation
evidence refuses a new swap rather than resetting the amount already submitted, and a claimed plan
remains single-use after restart. These local checks do not resume partially executed plans.

Gateway configuration rejects duplicate agent ports before starting listeners or child processes.
Distinct names must point to distinct loopback servers, including externally started servers.

DAO delegate preparation also uses an owner-scoped lock in the shared `.owner-intents/` directory.
Stop every instance and CLI writer sharing that directory before upgrading; older versions do not
take this lock. Keep the entire state listed above unchanged. There is no record-format conversion.
A competing preparation refuses for retry. A dead holder's lock becomes eligible for takeover after
10 seconds; do not delete a live lock. Instances on different hosts or using separate state directories
are not coordinated by this lock.

An unresolved submitted delegate keeps other preparations blocked until the original instance's
owner-intent recovery records an outcome. Expiry alone is insufficient. Owner success permits a
later preparation even when the released payout is still settling. Preserve older settled records
without outcome evidence and investigate them; do not fabricate a result or delete them to unblock.

## Releasing to both services

| Service | Executes | Persistent state |
|---|---|---|
| `dao` (`Dockerfile.gateway`, packaged) | Treasury; payout is approve-only here | Existing `/data/state`, including both agents' settings and this host's owner intents |
| `invoices` (`Dockerfile.payouts`) | Payout | Existing `/data`, including invoice SQLite, agreements and payout settings |

The `dao` image is built only from a package made by `scripts/package-shared-frontends.mjs` (Proto's built
`web/dist` plus the Treasury and Payables builds), which copies in `Dockerfile.gateway` as the package's root Dockerfile
and `deploy/railway.gateway.json` as its `railway.json`. The image runs `deploy/shared-frontends.json`.

Both services must use the same reviewed source and frozen lockfile. Rebuilding `dao`
alone does not update the public invoice page. Preserve `AGREEMENTS_URL` and matching
`AGREEMENTS_SECRET` configuration so the approve-only dashboard continues reading the executor's
agreements; do not copy its store to the dashboard as a substitute.

### Owner-run rollout

1. Confirm no unattended observation or freeze window is in progress. Coordinate a maintenance
   window with all sessions and stop new invoice submissions, approvals and dashboard/CLI money
   actions. Turn schedules off and retain that setting for validation. If a provider-enforced stop
   is required, the owner must freeze the policy; schedule-off alone does not block invoice or
   manual sends, and already-submitted operations may still finish.
2. Record each service's deployment/source identity and retained unresolved/owner-action records
   privately. Stop both services and every other writer before backing up. Preserve the complete
   state listed at the top of this guide, including `.notify/`, legacy `.intake/`, settings, SQLite
   journals and `.sqlite.initialized` markers. Use consistent backups and retain checksums; never
   delete a marker, rewrite legacy uncertainty, or discard an owner intent to clear a blocker.
3. Deploy the reviewed release to `invoices` first, reusing its existing `/data` volume and
   configuration, with one replica and no old executor still running. Keep new submissions paused;
   check `/health`. Startup reconciliation may update records, so preserve any new state even if
   the next deployment fails. Before restarting, review retained prepared and submitted owner
   actions: the owner-intent watcher can submit a signature already produced by a passed DAO vote.
   Pausing new approvals and schedules does not make startup status-only, and a policy freeze
   does not block every kind of owner action. Record any automatic progression without deleting
   or replacing the retained action.
4. Deploy the same release to `dao`, reusing `/data/state`, one replica, and the existing
   treasury-executor/payout-approve-only mapping. Every other copy of either agent stays
   `EXECUTOR=off`. Do not use restore/bootstrap variables to overwrite existing state. Check
   `/health` before reopening use; do not enable schedules as part of a health check.
5. Reload dashboard and invoice tabs after both services are ready. Discard stale confirmation
   dialogs, not durable prepared/submitted actions. Follow existing owner-action records after
   reload; an attempted owner signature remains poll-only, never resubmitted as a fresh action.

### Verification and recovery

The owner runs the read-only smoke command before and after the rollout:

```sh
DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke
```

For signed-in checks, use `SMOKE_COOKIE_FILE` and `SMOKE_SNAPSHOT` paths in the private release
record, not tracked files. Compare the same snapshot before and after. Smoke deliberately avoids
`setup`, `held` and invoice-list reads that may update records, and does not prove all new routes
work. A subsequent owner-run screen walkthrough is non-money-moving but can refresh local records:
check agreements/invoice ordering, funding disclosure, retained payment and owner-action states,
strategy readiness, and a retained recording with source gaps. Do not submit invoices, approve
payouts, enable schedules, continue prepared invoices or choose Run now just to verify the UI.
An unavailable read must remain explicit; never replace an unresolved payment to make the check pass.

If health, access, state comparison or contract checks fail, keep activity paused and retain the
new state and logs. Do not restore an older snapshot over post-startup records or downgrade writers
without reviewing state compatibility and reconciling operations. The preferred recovery is a
reviewed forward correction. Record UTC verification times, deployment IDs and source identity;
operation IDs, hashes, amounts and payees stay private. Reopening submissions, unfreezing and
resuming schedules are separate owner decisions. `pnpm test:live` requires separate authorization.

## Dashboard

**Deploy the gateway on Railway** (service `dao`: the packaged `Dockerfile.gateway`, one replica, a volume at
`/data`). One container runs the public gateway (`src/gateway/server.ts`) and, on loopback beside it,
each agent server listed in `deploy/shared-frontends.json`. An agent with `"executor": false` runs approve-only.
Each agent names its `owner` (a Sputnik DAO, whose members sign in, or a wallet account, which signs in
itself). Dashboard permissions come from that owner or the DAO's policy; legacy `operators` fields are
ignored and should be removed from configuration. The gateway closes an agent whose own server reports a different owner, so
a wrong `owner` locks the agent rather than opening it.
Ownership verification uses the agent server's `ownerIdentity` read. Deploy matching gateway and
agent-server code together, or update agent servers first; older servers without that read deny
access when the gateway has no cached ownership evidence. This change needs no state migration.
Ship the capability-based gateway with its matching frontend. Old cached frontends have no compatible
role response and must be reloaded; server checks still deny unauthorized calls. A previously configured
DAO operator needs actual group membership and the relevant onchain permissions. Existing schedules
continue under their current signed policy and grant; removing dashboard access does not stop them.
All state lives on the volume in `/data/state`; the app stays in `/app`.

1. Create the service and attach a volume at `/data`. Build the package with
   `node scripts/package-shared-frontends.mjs <new directory> <treasury dist> <payables dist>` after `pnpm build:web`;
   its root `Dockerfile` (from `Dockerfile.gateway`) and `railway.json` define the build. The repository's own
   `railway.json` selects `Dockerfile.payouts` for the invoices service. Set the healthcheck path to `/health`.
2. Set `NEAR_INTENTS_AGENT_API_KEY`, `NEAR_INTENTS_AGENT_API_URL`, `NEARAI_API_KEY`, `FASTNEAR_API_KEY`,
   and `SESSION_SECRET` (random, 32+ characters). `TRUST_PROXY=true` is set in the image.
3. For the first boot only, give each agent its settings file as a base64 variable: `DAO_ENV` and
   `PAYOUT_ENV` for `.env.dao` and `.env.payout`. To move an existing executor's state, also set
   `RESTORE_ARCHIVE` (a base64 gzipped tar of its complete state, listed above) and `RESTORE_SHA256`
   (that tar's SHA-256). `deploy/dashboard-entrypoint.sh` restores only
   when the checksum matches and no state exists, and writes a settings file only if it is missing.
   Delete these four variables once the service has started: they hold grant tokens and owner intents,
   which from then on live only on the volume.
4. Deploy from the package directory with `railway up --service dao`. To test before DNS is in place, set `DASHBOARD_HOST` to the
   service's Railway domain. Sign-in is bound to that host instead of `host` in `deploy/shared-frontends.json`.
   Then point a CNAME at the target `railway domain status <domain> --service dao` shows, and remove
   `DASHBOARD_HOST`.

Each agent has exactly one executor, and nothing enforces that across machines: the executor lease
covers one host. Every other copy of an agent, such as the owner's laptop, sets `EXECUTOR=off`. Such a
copy needs no grant token (it shows the executor's grant, read from the API) and refuses to issue grants,
since the new token would be saved on the wrong machine. To move an executor back, stop the `dao`
service, copy the agent's state files out of `/data/state`, and remove `EXECUTOR=off` from the laptop's
settings file before starting it there.

To stop an agent's sends, freeze its policy by owner vote: the provider refuses every send while the
executor keeps reconciling. To stop one host from sending, set `EXECUTOR=off` there.

## Platform staging

The staging host, its configuration and the dated staging runs are in [platform staging](platform-staging.md).

## Payout executor

The payout executor now serves both the private dashboard and public invoice page. Stop an existing
payout server before starting `ENV_FILE=.env.payout pnpm invoices`: the dashboard listens on loopback
port 8790 and invoices on 8791. Both use the payout agent's existing grant, money lock and recovery
loop. One host is the agent's executor; any other instance of the same agent, such as the owner's
local dashboard while the executor runs on Railway, sets `EXECUTOR=off`: it reads and approves as the
owner but never sends, reconciles or serves invoices. A lifetime lease prevents a second
current-version executor on the same host/user; it is not distributed fencing.
For an existing `pnpm server` or gateway-managed worker, set `INVOICES_PORT=8791` in that worker's
settings instead. A gateway can point at the already-running loopback worker without `envFile`.

**Agreements across hosts.** Agreement requests and offers live with the invoice page, in the payout
executor's `.agreements/`. The hosted dashboard's approve-only payout instance reads and answers them on
that host: set the same random `AGREEMENTS_SECRET` (32+ characters) on the invoices service and in the
dashboard's `.env.payout`, and `AGREEMENTS_URL=https://invoices.multiagency.ai` in `.env.payout`. Without
the secret on the invoices service, its `/internal/agreements` endpoint doesn't exist; without both on
the dashboard, its Agreements list reads its own (empty) store.

## Invoice migration and deployment

**Upgrade and migration:** stop old invoice/payout writers first and back up the complete persistent
state listed above before starting the new executor. Existing JSONL invoice history is imported read-only: recorded outcomes (paid, failed, refused) are shown as
they were, open ones as needing review, and missing business-to-payment links are never guessed. Non-invoice operations continue using their existing `.ops/` JSONL log;
new invoice operations are authoritative in SQLite and projected into the same activity/recovery
views. Each legacy file is moved to `.invoices/legacy/` once imported, so a stale writer can only start a new
file, which is imported in turn; its ids are never filed again. The `.sqlite.initialized` marker
prevents a missing database from silently becoming an empty one; restore the database rather than
removing the marker. Preserve SQLite journals and use a consistent backup. Do not roll back to an
old writer after new SQLite payments without reconciling/exporting the new records.
The compensation store refuses a newer schema version (`compensation-store.ts`), and no build before SDK 0.1.0 has
been tested against records written by it (shared payout mode, required `approvedAmount`, no `payoutMode`), nor this
build against older approved records without `approvedAmount`. Treat a payout-executor rollback below SDK 0.1.0, after
its first compensation record, as unsupported until a compatibility test exists. A rollback to r2 leaves all
compensation and agent-connection state unread.
A journal line with method `withdraw` (a payout request's withdrawal, since P3b, written before `authorize` runs, so
also for a refused one) is unreadable to a build before it: that build refuses the whole journal ("unsupported record
shape"), so it sends nothing for that agent and its reads of that journal (status, held payouts, the dashboard) fail
too. That fails closed, but rolling an executor back past P3b after its first withdrawal request needs the
compatibility review first; hosted agents are executors.

**Deploy on Railway** (`Dockerfile.payouts`, selected by `railway.json`, one replica, one executor host per agent):

1. Move the payout executor and its persistent state together. Any other instance of this agent, such
   as the owner's local dashboard, runs with `EXECUTOR=off`. The database cannot coordinate with an
   independent volume.
2. Attach `/data` with the migrated state. Keep the existing payout agent's `AGENT_ID`,
   `AGENT_GRANT_TOKEN`, `NEAR_INTENTS_AGENT_API_KEY` and `NEAR_INTENTS_AGENT_API_URL` in the environment.
   These variables are its settings: what the service saves itself (a new grant token, the treasury link)
   isn't read back after a restart, so rotate its grant by changing `AGENT_GRANT_TOKEN` here.
3. Set `INVOICES_PUBLIC_HOST`, `INVOICES_SESSION_SECRET` (random, 32+ bytes), and optionally
   `INVOICES_TITLE`. Railway's `PORT` is the public invoice port; `AGENT_PORT` defaults to 8790 for
   private dashboard/RPC access inside the host. The public invoice listener exposes no dashboard RPC.
4. Review imported and unresolved records before submitting new invoices. An outcome without a
   correlation ID requires provider/operator investigation; there is no assumed lookup-by-key API.


## Journal v2 and owner-intent locking upgrade

The journal reader also recognizes standalone version-1 authorization snapshots attached to an
unversioned preparation. These historical records remain unchanged and are ignored for lifecycle
decisions: they never establish that an operation was submitted, settled or safe to retry. Unknown
versions, orphan snapshots and snapshots mixed with lifecycle fields still refuse. No conversion
is required. Validate the retained journal with the candidate reader on a disposable backup copy
before starting the executor: from the candidate's source, `pnpm journal:check <backup state directory>` copies the
backup to a temporary directory, reads every `.ops/<agent>.jsonl` (with its invoice SQLite) with this build's reader, and
prints each agent's operation and blocking counts or the first invalid line; exit 1 means sends would refuse after the
deploy. Source-only tests do not establish compatibility with every history.

This is an additive state-format migration. Stop the executor and every server/CLI that writes this
agent's operations or this instance's owner intents before installing the new build. Do not perform
an overlapping rollout with old writers: they do not participate in the owner-intent lock or write
journal submission claims.

1. Back up the complete state listed at the top of this guide, including `.ops/`, `.invoices/`,
   `.owner-intents/`, `.strategy/`, `.plans/` and `.evidence/`. Preserve SQLite journals and settings.
2. Keep existing JSONL and owner-intent JSON files in place. No rewrite or backfill is needed:
   unversioned operation records remain legacy, and missing submission evidence remains ambiguous.
   Never add `journalVersion: 2` to an old request to clear an unresolved operation.
3. Start only the new build. New non-invoice request lines carry `journalVersion: 2`; a separate
   `SUBMISSION_ATTEMPTED` line commits before the provider call. Startup/reconciliation acquires the
   money lock and may append `never_submitted` only to an unclaimed v2 preparation. Existing invoice
   records keep their SQLite schema and continuation rules.
4. Owner-intent JSON retains its format. All new writers lock its per-instance path and reload it
   before updating; expired preparations and settled-token cleanup run under that lock too. A dead
   writer's lock must become stale before takeover. Do not delete a live writer's lock.
5. Review unresolved operations before resuming work. An attempted operation without an ID still
   requires investigation. Do not downgrade to writers that ignore v2 claims or owner-intent locking;
   stop and review state compatibility before any rollback.

This migration preserves historical evidence and does not reinterpret legacy uncertainty as proof
of non-execution. The fixes have offline process-crash and concurrency coverage; deployment remains
a separate owner action.

## Unattended run: observing the treasury autopilot

How a 24-hour observation of the autopilot is started, recorded and reported (`pnpm run-report`): [unattended run](unattended-run.md).

## Run progress rollout

The writer creates `.evidence/progress/<agent-id>/` when it records the first observation.
No migration command or existing-state conversion is needed. New start lines optionally identify
progress format 1; new end lines may flag incomplete progress. Recording exports use envelope
version 2 for these ticks. Historical version 1 recordings remain supported.

1. Stop the executor for the agent and confirm that no unattended observation or freeze window
   is active. Keep all other instances approve-only. The executor lease is single-host,
   not distributed fencing; it cannot detect an executor on another host.
2. Back up the entire state volume, preserving `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`,
   `.plans/`, `.evidence/`, `.inbox/`, `.agreements/` and `.notify/` together.
3. Deploy the reader, dashboard and executor from the same release, then restart the single executor.
   Check a private recording for stage events and confirm unknown outcomes remain unresolved.
   This rollout and any mainnet action are the owner's actions; they have not been performed here.

For rollback, stop the executor again and retain every state directory, including progress files.
Older code ignores the optional start/end fields and does not read the progress directory; it cannot
show the intermediate history. Keep the newer reader available for version 2 downloads. Never
convert a version 2 file to version 1 by relabeling it.
`test/run-progress.test.ts` verifies automatic initialization and existing-state preservation offline;
the recording tests cover historical ticks without progress.

## Scheduling cadence and local refactoring

The scheduler currently counts its interval from the latest inbox `run` summary, written before the
final after-observation and tick evidence end. Warnings and dismissals do not change that timestamp.
An interrupted evidence start does not itself advance the schedule; an unresolved operation still
blocks sends through the existing money lock. `test/autopilot.test.ts` checks these distinctions offline.
Keep `.inbox/` alongside `.evidence/` during preservation and migration. No new scheduler checkpoint or
state migration is introduced by the planning extraction; switching scheduling sources would require
separate restart semantics and compatibility tests.

The planning extraction keeps `.plans/` filenames, JSON, content digests and execution claims unchanged.
It changes the source digest, so identify any deployed build with its own release record. The optional
`DASHBOARD_AREA` setting changes presentation, not authorization. Configure an external agent server's
area explicitly as well as its gateway entry; gateway-managed children receive it from `area`.

## Task-flow and RPC extraction candidate

The task-flow extraction adds a private, member-readable `instance` procedure and preserves existing
RPC paths and action permissions. Ship the gateway allowlist, agent server and frontend from the same
reviewed build so the provider-independent schedule-stop view can read instance mode. This work
changes no state formats and requires no conversion. Preserve all existing state directories as usual.
The lazy application entrypoints and recovery views are verified locally with intercepted browser
requests; deployment, restarts and hosted verification remain separate owner actions.

An inherited `EXECUTOR=off` remains a process-lifetime restriction even if the instance settings file
contains `EXECUTOR=on` or settings are saved at runtime. Changing executor ownership requires the
existing stopped-executor procedure; instance-file loading cannot lift that restriction.

## Self-service setup and hosted reservations (prepared, not deployed)

The prepared `deploy/dashboard.json` enables `walkthroughs` and `selfService`. The first selects
sign-in and real-funds guided walkthroughs as the entry; the second admits verified wallets to
reserve their own agent setup. Disabling new self-service setup does not delete existing reservations;
the gateway still loads and starts their instances. Keep one gateway replica on this host.

Preserve `.hosted/registry.json` and every `.hosted/own-*.env` file with the existing `.ops/`,
`.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`,
`.notify/` and `.work-orders/` directories on `/data`. The registry and settings are private state,
never release artifacts. Back up and restore them together with stopped executors. Existing records
need no conversion: this is additive state. A missing settings file, corrupt registry, conflicting
port or orphan settings file requires recovery of original state; do not delete it to retry creation.

Each reservation uses a distinct loopback port from 9000–9999, excluding configured agent ports and,
for a new reservation, ports another process holds at that moment. Keep this range available: an
existing reservation keeps its port, and if another process holds it, the agent stays unavailable
(owner calls are refused, nothing is sent to that process) until the port is free: the agent's server
can't bind it and exits, and the gateway restarts it with backoff (up to 5 minutes between attempts). Capacity is 32 reservations, with one per owner and area, or for an app's setup one per app
deployment, Organization, owner and area, at most 16 per deployment. Self-service reservations stay in
`.hosted/registry.json`, in the format earlier releases read; an app's Organization reservations are in
`.hosted/apps.json`, which earlier releases ignore. Preserve both with the `own-*.env` files. Rolling back to a release
before Organization scopes: the gateway starts, and the Organization agents stay down until a release that reads
`apps.json` runs again (shown with the previous release's registry code, 2026-10-26). Don't add self-service
reservations while rolled back: one could take a port an Organization agent holds, and the newer release then refuses
the registry until it is recovered. Entries written before Organization scopes keep their names and need no
conversion. There is no
self-service deletion or automated cleanup; retain incomplete setup for recovery. The host operator
can read all instance state. Single-host leases do not provide distributed fencing or isolation
from a hostile host. Load capacity and admission abuse resistance remain unverified.

New agents start with autopilot off and no grant, and inherit no existing owner’s notification or invoice destinations. Setup requires an explicit wallet signature or
DAO proposal, then the existing policy/grant/funding checks. New Payables agents use manual
payments; their payee invoice intake is not provisioned. The existing payout executor and its
invoice service keep their current roles. Offline tests cover reservations, restart, ownership
binding and browser setup; real wallet/Trezu creation must be separately observed after user deployment.

## FastNear reads

### Access and keys

Keep `FASTNEAR_API_KEY` configured server-side on both services. `src/fastnear.ts` sends it as a Bearer
header to FastNear RPC, Transactions and Transfers APIs. With a key and no
`NEAR_RPC_URL` override, RPC uses `https://rpc.mainnet.fastnear.com`. Check the effective override
privately: empty values now use the default, and custom hosts receive no FastNear authorization
header. Only exact documented HTTPS hosts receive the key. Use the intended FastNear host; never put the backend key in browser code or copied URLs.

The integration already uses canonical RPC for account, DAO policy and access-key reads;
Transactions for DAO execution discovery (including relayed transactions) and deposit receipts;
and Transfers for public `intents.near` books. This matches FastNear's documented separation of
[RPC and indexed APIs](https://docs.fastnear.com/agents/choosing-surfaces), checked 2026-10-14.
The [authentication guide](https://docs.fastnear.com/auth) documents one key across these APIs.
Key presence alone does not prove deployed access or indexer freshness. During owner-run
verification, distinguish authentication/rate-limit failures from missing records and inspect the
relevant indexed service's `/status` when investigating lag. Indexed public history does not prove
confidential settlement, authorize a retry, or replace provider evidence for an unresolved operation.

Future read-performance work should measure existing calls first, then consider batching deposit
receipt lookups by transaction hash; DAO discovery already batches those lookups. Keep missing evidence explicit and validate any
change to recovery or authorization separately.

### Scan bounds and status report (offline-tested, 2026-10-16)

Indexer scans for public transfers and DAO signatures have a 100-page, two-minute bound;
repeated cursors fail explicitly. An incomplete read is not an empty history or permission to replay.
An operator can run `node --env-file-if-exists=.env --import tsx scripts/fastnear-status.ts`
for a sanitized read-only status report (latency, HTTP status and numeric indexer height/lag fields).
Missing fields remain null; published source does not establish the deployed service version.
This diagnostic has been offline-tested, not run against production in this follow-up.

### Request bounds and failures (local candidate)

FastNear failures retain safe operator guidance and now distinguish authentication, rate limit,
unavailability, malformed responses, incomplete evidence and cancellation internally. No upstream
body, credentials or raw exception causes are included. FastNear workflows share a two-minute
Effect deadline; each request, including response-body consumption, is also bounded at 30 seconds.
Failure or cancellation aborts active requests and stops queued lookups. These reads never retry
automatically. Separate Agent API reads and the ten-second status diagnostic retain their existing
bounds. Public history still cannot establish confidential settlement or authorize a replay.
