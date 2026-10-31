# Operations

For the deployed four-domain integration, start with the [release execution record](proto-release-execution.md)
and [reviewed release procedure](proto-release-review.md). The earlier
[shared-demo plan](shared-demos-rollout.md) is historical preparation, not the current deployment recipe.
Future production changes require their own authorization and must preserve executor assignments
and all four volumes. No deployment or restart is implied by committing source changes.


These instructions describe the repository configuration. Deploys, restarts and money actions are
performed by the owner. For the product and recorded results, see [README](../README.md).

Preserve the complete state when moving an executor. This is the canonical list; AGENTS.md,
`scripts/check-shared-image.mjs` and `docs/agent-access-release.md` repeat it, and `test/state-directories.test.ts`
keeps them equal:
<!-- state-directories -->
`.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/`, `.hosted/`, `.agent-connections/`, `.machine-auth/`, `.app-access/`, and any legacy `.intake/` files
<!-- /state-directories -->
plus each instance's settings file. `.ops/` also holds each executor's `<agent>.submission-evidence.ndjson` (provider answers to failed sends; evidence only, never read to decide a send). `.invoices/` includes its SQLite journals and the compensation store
(`<agent>.compensation.sqlite`); `.notify/` records which alerts were sent (losing it re-sends them); `.agent-connections/`
holds agent connections and their access log (see [agent access](agent-access.md)); `.machine-auth/` holds Treasury
machine credentials; `.app-access/` holds app service credentials (hashed), owner consents, revocation tombstones (`revoked/`,
never delete: losing one lets that consent be stored again), held confirm-page actions (`confirm/`, one record per link,
named by its token's hash, and a `.claim` file once a submission was made; an older build ignores them) and the access log; run `pnpm app-credential check-keys`
on a schedule so a removed owner key ends its consents even when no call observes it. Consents belong to the deployment
name: a credential issued under an existing deployment name acts on all of its consents, so use a new name for an
app that shouldn't inherit them; `.hosted/` the hosted agent registry. Stop writers before copying state; never start the destination before stopping the
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

## Combined UI, strategy and recovery candidate

This is the locally prepared candidate based on `5cd6cc9fbb584a3174b6d7586fbdda8633cf4d45`,
not a deployment record. The base commit alone does not identify its uncommitted changes: retain
the reviewed file-hash manifest and the final release commit or source-archive checksum in the
private release record. Recheck changes made after validation before shipping. Local browser
fixtures and offline tests do not establish hosted behavior or actual screen-reader speech.

### What ships where

| Service | Candidate changes | Persistent state |
|---|---|---|
| `dao` (`Dockerfile.gateway`, packaged) | Dashboard simplification; reviewed policy/payment confirmations; strategy save, authorization and enable controls; payment/owner-action recovery views; private AG-UI recording inspector/export. Treasury executes here; payout remains approve-only. | Existing `/data/state`, including both agents' settings and this host's owner intents |
| `invoices` (`Dockerfile.payouts`) | Invoice agreements precede amount fields; stable focus during refresh; continuation of unchanged, never-submitted invoices; shared payout/backend changes. Payout executes here. | Existing `/data`, including invoice SQLite, agreements and payout settings |

The `dao` image is built only from a package made by `scripts/package-shared-frontends.mjs` (Proto's built
`web/dist` plus the Treasury and Payables builds), which copies in `Dockerfile.gateway` as the package's root Dockerfile
and `deploy/railway.gateway.json` as its `railway.json`. The image runs `deploy/shared-frontends.json`.

Both services must use the same reviewed source candidate and frozen lockfile. Rebuilding `dao`
alone does not update the public invoice page. Preserve `AGREEMENTS_URL` and matching
`AGREEMENTS_SECRET` configuration so the approve-only dashboard continues reading the executor's
agreements; do not copy its store to the dashboard as a substitute.

Invoice refreshes display only the latest requested read. Superseded responses cannot restore old
invoice controls or clear a newer read failure (`test/browser/invoices.cjs`, offline fixtures).

The subsequent [live run view](live-run.md) integrates automatic AG-UI snapshot refresh into recent run timelines in the
dashboard, using the existing private recording endpoint. It introduces no stream endpoint or
state migration. The shared FastNear helper now reports read failures explicitly and rejects
malformed JSON; ship that correction to both services with the same reviewed candidate.

The recording adapter now exports envelope version 3 with AG-UI protocol 1.0 lifecycle validation.
The dashboard continues to read archived versions 1/2. Exports are derived from existing records;
this envelope change needs no stored-record conversion and adds no directory. Preserve the run
progress and evidence stores described below. Verify the reader and exporter together from the
same candidate; this compatibility is offline-tested, not a deployed-host observation.

### FastNear access for this candidate

Keep `FASTNEAR_API_KEY` configured server-side on both services. `src/chain.ts` already sends it
as a Bearer header to FastNear RPC, Transactions and Transfers APIs. With a key and no
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

No additional FastNear UI or API feature is introduced here. Future read-performance work should
measure existing calls first, then consider batching deposit receipt lookups by transaction hash;
DAO discovery already batches those lookups. Keep missing evidence explicit and validate any
change to recovery or authorization separately.

### Compatibility and state

- Dashboard `pay` and `owner/prepare` policy updates now require `expectedPolicy` (revision and
  mandate digest). Old requests without it fail validation before provider reads. A changed review
  is refused; reload the page and review again rather than replaying the old request.
- Treasury grant preparation requires the saved `expectedStrategyDigest` and the schedule off.
  New `strategy/get`, `strategy/save`, `autopilot/enable` and `autopilot/stop` routes support the
  workflow. Legacy `autopilot/set` can stop unchanged settings without a digest, but refuses
  unreviewed changes/enablement and combined change-and-enable requests. A stale settings form
  may therefore fail even when its button says Turn off: refresh and use the new stop control.
- `owner/actions`, `paymentHistory` and `autopilot/log` are private member reads. Strategy writes
  require settings permission; enabling scheduling requires execution permission. Approve-only instances refuse strategy changes
  and recording export. Owner-action history is local to its instance; payout discovery is bounded
  to 250 provider records from the past day and reports incomplete scans. Missing reads are not
  proof that no payout or owner action exists.
- `POST /api/invoices/:id/continue` uses the authenticated payee's stored terms and identity.
  It refuses revised or submission-attempted invoices; it is not a retry for unknown outcomes.
  The `/internal/agreements` contract is unchanged. Old/new mixed builds are not a validated
  operating configuration; keep activity paused until both services are upgraded.
- No SQLite, journal, owner-intent or strategy schema changes are introduced relative to this
  candidate's base. The invoice SQLite and journal-v2 migrations below already exist in that base
  (and in recorded source `9b2941a`). Do not rerun migration or initialize empty stores merely
  because this release adds recovery views. If the actual deployed source/state is older or
  unknown, establish compatibility and apply the relevant stopped-writer procedure first.
- Strategy controls add a transient single-host control lock beside the existing strategy file;
  strategy saves persist schedule-off before replacement. This is not distributed fencing.
  AG-UI exports read existing evidence/journal files and add no durable recording store.

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
3. Deploy the reviewed candidate to `invoices` first, reusing its existing `/data` volume and
   configuration, with one replica and no old executor still running. Keep new submissions paused;
   check `/health`. Startup reconciliation may update records, so preserve any new state even if
   the next deployment fails. Before restarting, review retained prepared and submitted owner
   actions: the owner-intent watcher can submit a signature already produced by a passed DAO vote.
   Pausing new approvals and schedules does not make startup status-only, and a policy freeze
   does not block every kind of owner action. Record any automatic progression without deleting
   or replacing the retained action.
4. Deploy the same candidate to `dao`, reusing `/data/state`, one replica, and the existing
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

A `staging` environment in the platform's Railway project serves app access for the dashboard's staging
(`dev.multiagency.ai`) at `api.dev.multiagency.ai`; production would be `api.multiagency.ai`. Consents and setups name
this host as their NEP-413 recipient, so it isn't renamed once owners have signed. Staging runs on mainnet (the provider
has no test network) with its own state and test agents, never the live demo hosts' records.

Staging is meant to run the `platform` package (`scripts/package-platform.mjs`, built by every release candidate beside
`dao`): the gateway as a headless host (`headless` in its config), which serves `/health`, app access (`/apps/v1`) and
the confirm page with its own assets, and answers 404 to everything else, before reading any session: no sign-in,
owner app, owner RPC, machine credentials or demo hosts. App setup is limited to the areas `appSetup` lists (Payables
only). It has run it since 2026-10-31T01:03Z (release candidate `b9221b45`, commit `01add07`, Railway deployment
`4900d1c4`, image `1b74b1fa`); before, it ran the `dao` package, which also served the prototype's owner app and
sign-in there. Read-only checks on 2026-10-31T01:06Z: `/health` 200; `/apps/v1/agents/x` 401 without a credential and
403 with a browser `Origin`; `/`, `/gw/challenge`, `/gw/me`, `/a/x/access`, `/machine/v1/…`, an unmatched `/confirm/…`,
owner-app assets and `/build-manifest.json` 404; `POST /gw/session` 404. Switching needed no migration: the state
directory, hosted agents and consents are kept, and the host is unchanged, so signed consents and setups stay valid.

1. In the platform's Railway project, create `staging` as an empty environment (a duplicate copies production's
   services and variables) and add one empty service, `gateway`, with its own volume at `/data`, one replica,
   healthcheck `/health`.
2. Variables: `DASHBOARD_FILE=/app/deploy/platform-staging.json` (host `api.dev.multiagency.ai`, `headless`, app setup
   for Payables, no configured agents: every agent is a hosted agent created through app setup), `NEAR_INTENTS_AGENT_API_KEY` (a separate
   key for staging from the same partner account, so it can be revoked without touching production's), `NEAR_INTENTS_AGENT_API_URL`,
   `FASTNEAR_API_KEY`, and a new `SESSION_SECRET`. No `DAO_ENV`, `PAYOUT_ENV` or `RESTORE_*`.
3. Deploy the release candidate's `platform` package: from `<release>/platform`, `railway up --service gateway
   --environment staging`. To check before DNS, set
   `DASHBOARD_HOST` to the Railway domain, then point a CNAME for `api.dev.multiagency.ai` (Namecheap) at the domain
   `railway domain status` shows and remove `DASHBOARD_HOST`.
4. Read-only checks: `/health` 200; `/apps/v1/agents/x` without a credential 401, with a browser `Origin` 403, on another
   host 421; `/`, `/gw/challenge` and `/a/x/access` 404 (offline-tested in `test/platform-host.test.ts`).
5. On the staging service, the operator issues the dashboard's credential from the gateway's own state directory (it
   writes `.app-access/` there, beside the gateway): `cd /data/state && /app/node_modules/.bin/tsx
   /app/src/app-credential.ts issue multiagency-dashboard api.dev.multiagency.ai 90 "MultiAgency dashboard"`. The token
   goes only into the dashboard staging's server secrets (`PLATFORM_APP_CREDENTIAL`, with
   `PLATFORM_URL=https://api.dev.multiagency.ai` and `PLATFORM_DEPLOYMENT=multiagency-dashboard`). Deployment names follow
   `<publisher>-<app>` and are the same on every host: the host separates staging from production, and a credential is
   bound to one host (user, 2026-10-31; provisional until the first real owner on production). `staging` is the
   platform's own test deployment (the stand-in runs below); a credential under it acts on that deployment's consents.
6. Rollback: redeploy the previous image; state stays on the staging volume. Nothing here touches proto.multiagency.ai
   or invoices.multiagency.ai.

Production (`api.multiagency.ai`, not set up) is the same package with `deploy/platform.json`, the image's default
`DASHBOARD_FILE`: a new service in the platform's Railway project with its own volume, its own provider key and session
secret, and the production app credentials issued on it. Production's `dao` service is unchanged.

### Staging evidence on a test agent (run 2026-10-28: [mainnet log](mainnet-log.md#app-access-on-platform-staging-2026-10-28-utc))

User-run, on mainnet, with a small amount of the user's own USDC; never scheduled. It shows the app path end to end:
setup, creation on the confirm page, consent, a payout request held for the owner, and the owner's vote relayed by an
app. Until an app's own screens exist, the app is the local testing UI, `scripts/staging-app.ts`: it holds the
staging credential in one local process and has the owner's wallet sign app texts in a localhost page. It switches
between Organizations and agents, shows the agent's policy, balances, held payouts and recent owner actions ("Refresh
view"), and keeps every call and answer in a history that can be copied out for this log. Test tooling only; never
deployed. The runs below used its earlier, single-Organization form, whose buttons were named differently: "Sign setup
text and submit" (now "Sign setup text"), "Sign consent (owner, payout, read)" (now "Sign consent", scopes chosen
beside it), "Add payee" and "Agree payee for withdrawal" (now "Add transfer payee" and "Add withdrawal payee", which add
to the payees in force instead of replacing them), "Vote approve on the held payout" (now "Vote approve") and "Held"
(now part of "Refresh view"). Edits it builds from the policy name the revision and digest they were read under, so the
platform refuses them if the policy changed in between.

Before starting: staging deployed from a candidate that includes app votes and the confirm page; a staging credential
issued (step 5); an owner wallet whose key is a full-access key of the owner account (check with `view_access_key`) and
that signs NEP-413 messages, and for the confirm page NEP-366 delegate actions (Meteor and Intear did when last checked);
a payee account that exists on NEAR, ideally the user's own second account; no other staging run in progress.

1. Start the stand-in from the repository root, with the credential only in the environment:
   `PLATFORM_URL=https://api.dev.multiagency.ai PLATFORM_APP_CREDENTIAL=tap_… PLATFORM_DEPLOYMENT=staging
   ORGANIZATION=org_step8 pnpm exec tsx scripts/staging-app.ts`, then open `http://127.0.0.1:4318/` and connect the wallet.
2. Set up: sign the setup text. Expect the Organization's agent name in the answer.
3. Create the agent. Per the provider's docs creation is NEP-366, so the platform's confirm page opens: check that it
   names this deployment, Organization and agent and shows the payout policy at creation, then sign twice (the page's
   own text, then the action). Read the owner status until `SUCCESS`. Record the standard that came back, the wallet,
   and what the wallet showed for each of the two signatures.
4. Sign the consent (owner, payout, read). Expect it stored.
5. Issue the payout grant (NEP-413 per the provider's docs: signed in the stand-in). Read the owner status until
   `SUCCESS`.
6. Add the payee. The payout agent was created with transfers on and no payees, so the first payee changes only
   `destinations`, which per the provider's docs is signed NEP-413: expect it signed in the stand-in, not on the confirm
   page. Record which standard came back; if the confirm page opens instead, check it shows `destinations` before and
   after.
7. Fund the agent: take a deposit address in the stand-in ("Deposit address", the agent's `deposit` under the payout
   consent) and send the USDC there, with the memo if one is given, before it expires and above any minimum shown. A
   deposit credits the confidential balance directly (mainnet-observed 2026-10-13 on a treasury agent; not yet on a
   payout agent).
8. Request a payout with a new request ID and the amount. Expect `held` (the payout policy holds every payout for the
   owner). Ask again with the same request ID and terms: expect the same answer and nothing new sent.
9. Vote approve from the stand-in. Before signing, check the prepared vote's `payment.terms` against the request.
   Record what the wallet shows for the vote; the recorded format (`approve:{approval_id}:{wallet_pubkey}:{request_hash}`,
   2026-10-11) names no payee or amount, so expect only an identifier and a hash. Read the payout status until
   `succeeded`; the payee checks the receipt in near.com.
10. Optionally freeze and unfreeze, each on the confirm page.

Stop rules: a payout reading `unknown`, or `processing` that doesn't settle, is never retried under a new request ID;
stop and report. A refusal is recorded with its code. Afterwards the agent remains (hosted agents are never released)
with any remaining funds under the signed policy; the consent ends when it expires or the operator revokes it
(`pnpm app-credential revoke-consent <consent id>` on the host).

Record each step's outcome in `docs/mainnet-log.md` with the date (UTC) and the deployment id; op ids, transaction
hashes, amounts and payees go only in the private release record.

### Staging withdrawals on the same test agent (run 2026-10-30: [mainnet log](mainnet-log.md#payout-withdrawals-on-platform-staging-2026-10-30-utc))

User-run, on mainnet, with small amounts of the user's own wNEAR and USDC; never scheduled. It shows what is offline-
and stack-tested only: a withdrawal to a NEAR account arriving (wNEAR as native NEAR, USDC as USDC), the fee 1Click
takes, the registration refusal, and what a held withdrawal's approval carries. The stand-in drives it, as above.

Before starting: staging deployed from a candidate that includes withdrawals and the registration check; the test agent
from the run above, with its consent, grant and payee; the payee registered on the USDC contract (`storage_balance_of`
answers an object, not `null`); a second NEAR account that exists and is not registered on USDC (`null`); no other
staging run in progress.

1. Start the stand-in as above and enter the agent's name. Each policy edit below opens the confirm page: check the
   fields it shows before and after, then sign twice. Read the owner status until `SUCCESS`.
2. Agree the payee for withdrawal ("Add withdrawal payee"). Expect `actions` to gain `withdraw` and `destinations`
   a `withdraw` entry on chain `near` with no memo.
3. Allow wNEAR with a small cap ("Allow wNEAR", in yoctoNEAR). Expect `assets` to gain `nep141:wrap.near` and `limits` a
   wNEAR cap per payout, day and month, every other cap unchanged.
4. Turn owner approval off. Every payout within the policy is then paid without a vote, transfers included, until
   step 9.
5. Fund wNEAR: "Deposit address" with asset wNEAR, then send wNEAR as the answer says.
6. Request a small wNEAR withdrawal (delivery "withdraw to chain near"). Expect `succeeded`. Record the payee's native
   NEAR received against the amount (the fee), and how long it took.
7. Request a small USDC withdrawal to the same payee. Expect `succeeded`; record the USDC received against the amount.
8. Request a USDC withdrawal to the unregistered account. Expect the refusal `recipient_not_registered`, with nothing
   recorded (`payouts/status` reads `not_found`) and nothing sent.
9. Turn owner approval on. Request a small wNEAR withdrawal: expect `held`. Record what `held` and the owner status show
   for it. Vote approve: expect it refused before the wallet is asked (approving a held withdrawal isn't available).
   Vote reject (signed in the stand-in): expect `failed` and nothing paid.

Stop rules as above. Record each outcome in `docs/mainnet-log.md`; amounts, fees and payees go only in the private
release record. What step 9 shows decides whether approving a held withdrawal can be bound and enabled
([enforcement](enforcement.md)).

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

How a 24-hour observation of the scheduled autopilot is started, recorded and reported. It answers one
question: does the scheduler run on its own without missed ticks, duplicate execution, actions outside its
schedule, or manual recovery? It says nothing about custody guarantees or economic benefit
([enforcement](enforcement.md)).

### What records the evidence
- **The scheduler itself**, not a watcher, appends synced lines to `.evidence/<agent id>.jsonl` in the
  agent's state directory (on `dao`, `/data/state/.evidence/`, a volume with backups enabled). See
  src/evidence.ts.
  - **`start`, written before the tick acts:** a unique tick id, the trigger (`schedule` or `operator`),
    the scheduler's recorded settings (on, interval, limit, and the run its schedule counts from), and the
    build: Railway's deployment id plus sha256 digests of the `src/` tree, `pnpm-lock.yaml` and
    `package.json`. Also the policy revision and digest, the strategy digest, and the live grant's id and
    label (never the token).
  - **`end`, written after:** the book, drift, budget usage and unresolved operations before and after;
    the plan with its legs and quotes; each step's and shield's status and correlation id; rejection
    reasons; a proven refusal's code; and the tick's own summary.
- **Write failures:**
  - If the start can't be written, the tick doesn't run and the inbox says so.
  - If the end can't be written, the inbox says so.
  - A start without an end is reported as incomplete (interrupted, or outcome unknown), never as success
    or failure.
  - A line that doesn't parse, such as a torn final line, is counted as unreadable, not trusted.
  - Every log here appends through one function (`src/synced.ts`). After a torn final line, the next
    record starts its own line, so a crash mid-append loses only the torn line (offline-tested,
    `test/synced.test.ts`).
- **Interventions:** the gateway records every call classified by `isIntervention` in
  `.evidence/interventions.jsonl` (account, agent, procedure, time) before forwarding it. If the record
  can't be written, the call isn't run. Calls made on a host directly (CLI, shell) are not in this record.
  An unreadable line in the record is counted and fails the "no operator interventions" criterion, since
  it may have been a call. Builds up to c25b61b skipped such lines instead; `pnpm run-report` refuses a
  gateway that doesn't count them.
- **Reading the records:** `autopilot/evidence` on the treasury agent server, and `/gw/interventions`
  (execution or settings permission). In the build under observation (fe3330c), `autopilot/evidence` is operator-only too, so
  the gateway records each read of it in the intervention record; the report lists those reads separately as
  operator reads, not interventions. Later builds make it a member read, which the gateway doesn't record.
- **The report:** `pnpm run-report` (src/run-report.ts, logic in src/report.ts, tests in
  test/report.test.ts). It reads the evidence, the intervention record and the books, and reports:
  - each criterion;
  - configuration segments (build, mandate or scheduler settings);
  - every tick's outcome: executed, no-op, refused, failed, skipped or incomplete;
  - the incident behind each failed criterion.

Nothing depends on a chat session or a laptop staying up. Collection runs only while a build containing
src/evidence.ts runs on `dao`.

### How the report judges
- **Scheduled work:**
  - Only completed scheduled ticks count. Operator, skipped and incomplete ticks are named inside any gap
    they fall in.
  - Each gap is judged by the interval the later tick recorded, plus 3 minutes.
  - Records are sorted, and both window bounds apply.
- **Duplicates:**
  - "Duplicate references" (an operation or plan named by two ticks) is reported apart from duplicate
    execution.
  - Duplicate execution is confirmed only when one plan leg settled twice. An execution no tick recorded
    with the same terms as one a tick recorded is a suspected duplicate: separate operations can share
    terms.
  - If executions no tick recorded exist without such a match, the answer is "cannot be established",
    not "yes".
- **Unresolved operations** seen at a tick are reported as an observation. Interventions come only from
  the gateway's record and operator-triggered ticks, so "none" means none recorded there.
- **Refusals** show a control was invoked, not that it refused correctly. A failed shield or step, or an error, is a failure.

### Starting a window
1. Deploy a build whose `src/` contains authorization, evidence collection and the execution-mode
   removal, from a reviewed snapshot. Record the deployment id, image digest, and the snapshot's `src/`,
   lockfile and `package.json` digests.
2. Confirm the autopilot is on and hourly, and that the live grant approves the strategy in force.
3. Wait for the first scheduled tick. Its start line must match the deployment id and all three digests.
   Its end line fixes the starting book, budget and mandate.
4. The window starts at that tick, in UTC, and ends 24 h later.

### During the window
- Don't press "Run now".
- Don't force imbalances, raise limits or manufacture trades.
- A correct no-op or refusal is a valid outcome.
- Any operator action, payment or approval in the window is reported as an incident, not hidden.
- If the build, policy, strategy or grant changes, the report starts a new segment. Evidence from earlier
  segments still counts for its own configuration.

### Generating the report
Sign in to the dashboard with execution or settings permission. Save the `dao_session` cookie to a 0600 file, never
pasted anywhere. Then run:

    DASHBOARD_URL=https://proto.multiagency.ai REPORT_COOKIE_FILE=<file> \
    SINCE=<window start> UNTIL=<window end> OUT=<report.md> pnpm run-report

### Success
- **The run succeeds when** it has, with incidents recorded honestly:
  - no unexplained missed ticks;
  - no duplicate execution;
  - no execution outside scheduled ticks;
  - no unresolved operation needing manual recovery;
  - every tick able to read its book and mandate.
- **No particular number of swaps is required.**
- **Reported separately from the result:** operational reliability is one thing. Custody guarantees (atomic
  budgets, strict monthly caps, the bought asset) and economic benefit are separate claims that one day
  doesn't support.


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


### Self-service walkthrough deployment (prepared, not deployed)

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

Each reservation uses a distinct loopback port from 9000–9999, excluding configured agent ports.
Keep this range available. Capacity is 32 reservations, with one per owner and area, or for an app's setup one per app
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


### Offline infrastructure follow-up (2026-10-16)

Indexer scans for public transfers and DAO signatures have a 100-page, two-minute bound;
repeated cursors fail explicitly. An incomplete read is not an empty history or permission to replay.
An operator can run `node --env-file-if-exists=.env --import tsx scripts/fastnear-status.ts`
for a sanitized read-only status report (latency, HTTP status and numeric indexer height/lag fields).
Missing fields remain null; published source does not establish the deployed service version.
This diagnostic has been offline-tested, not run against production in this follow-up.


### Effect-based indexed reads (local candidate)

FastNear failures retain safe operator guidance and now distinguish authentication, rate limit,
unavailability, malformed responses, incomplete evidence and cancellation internally. No upstream
body, credentials or raw exception causes are included. FastNear workflows share a two-minute
Effect deadline; each request, including response-body consumption, is also bounded at 30 seconds.
Failure or cancellation aborts active requests and stops queued lookups. These reads never retry
automatically. Separate Agent API reads and the ten-second status diagnostic retain their existing
bounds. Public history still cannot establish confidential settlement or authorize a replay.
