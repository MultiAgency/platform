# Platform production: app access on api.multiagency.ai

The runbook for putting app access (`/apps/v1`) into production. Prepared 2026-11-05; **set up 2026-11-07** by the
user (below); every step here is the user's to take. It's the same `platform` package staging runs ([platform
staging](platform-staging.md)), with `deploy/platform.json` (host `api.multiagency.ai`, headless, app setup for
Payables only, no configured agents). The production environment's earlier prototype services (`dao`, `invoices`,
`invoices-frontend`, `payables`, `treasury`) were deleted on 2026-11-08; the user stated their agents were empty (not
checked: no balances, journals or agent lists were read); proto.multiagency.ai, invoices.multiagency.ai,
payables.multiagency.ai and treasury.multiagency.ai no longer answer.

**Credentials separated from staging by the owner, 2026-11-25 UTC.** Before the change, `NEAR_INTENTS_AGENT_API_KEY`,
`FASTNEAR_API_KEY` and `SESSION_SECRET` on production's `gateway` each equalled staging's (compared by hash, with
non-empty values; no value was printed). The owner set a new Agent API partner-portal key, a new FastNEAR key and a
newly generated 64-character `SESSION_SECRET` from stdin, after which all three differ from staging's; staging's values
are unchanged. `railway redeploy` reused the existing image as deployment `81e4cea7-2e2a-46b3-8da9-decb9ceb1054`
(`SUCCESS`, created 22:45:39Z), replacing `aaa6a437`. Read-only verification: Node v26.13.1 and
`/app/release-manifest.json` SHA-256 `f2718a6b…ee8d227` in the container, unchanged; platform smoke passed every
check at 22:54Z. Production has no agents, so the new provider key has not been used for any provider call yet; its
first check is the first production agent's read.

**0.6.0 on Node 26 deployed by the owner, 2026-11-25 UTC.** Release candidate `55d289c2` (source `93b7e5b`: the same
application source and Node 26 runtime as staging's `b945ffdd`, plus documentation commits) passed every gate under
Node 26.13.1: typecheck, offline 1,536 of 1,536, evidence, web build, browser, E2E and challenges, SDK pack and skills,
and the image booted twice with all 257 packaged hashes matching. The owner uploaded its `platform` package from a copy
outside any git repository as deployment `aaa6a437-3f98-4870-9b4a-0ba36343050e`; the build used `node:26.13.1-slim`,
installed the frozen lockfile with pnpm 12.15.0 (provider SDK 0.8.2), passed the `/health` healthcheck and started
signing for `api.multiagency.ai`. Railway's `meta.imageDigest` for the deployment is
`sha256:8fa3c77ba91ce1dd27ecb304b0d2f39cf020343cb839c445e913d4935ece40c7` (read 2026-11-25), equal to the build log's
`containerimage.digest`. Read-only verification: Node v26.13.1 in the container, and
`/app/release-manifest.json` SHA-256 `f2718a6b76baee41aa238b8a177acf51f5d593a8093c199498be89722ee8d227`, equal to the
candidate's; platform smoke passed every check at 19:07Z, with the confirm page loading this build's assets. The
upload replaced, without stopping it first, deployment `7a75ddcf-8855-4077-a64c-20142115ed55` (created
2026-11-12T22:57Z, image `sha256:e09bbd3f…`, upload note "Approved exact252cba1 production package; retain
maintenance": the 0.5.9 package (`252cba1`, tag `sdk-v0.5.9`), uploaded after the 2026-11-12 IaC apply below and not
recorded here until now; what "retain maintenance" referred to is not recorded. No hosted agent on production is
recorded: `deploy/platform.json` configures none and no production app credential is recorded as issued; after the swap
the owner listed the volume (names and sizes only, 2026-11-25): `/data/state` is empty and unchanged since
2026-11-08T04:56Z, and `/data` uses 2.1 MB and 13 inodes (Railway's `currentSizeMB` reported about 791 MB for the
volume, a different measure). So production held no retained state at the swap. No volume backup precedes this swap; the owner took a locked Railway
backup after it, listed at 16:14 −05:00 (21:14Z) on 2026-11-25, 790 MB. Either way the swap needed no stopped-executor
migration: 0.6.0 converts no existing record, and its only new journal record (`journalVersion` 4, `market-allocation`)
is written only by a Market allocation, which a 0.5.9 reader refuses. Rollback is redeploying `7a75ddcf`; it is safe only after reviewing any records written since. These checks establish package identity, runtime and public host behavior, not app acceptance or any money
action.

**Infrastructure as Code applied by the owner, 2026-11-12 UTC.** The owner applied the pinned plan from source
`d741f3b`. Deployment `c9cba776-bd43-4353-9bcb-a15b5c64e95e` reached `SUCCESS`, with one `RUNNING` instance and image
`sha256:af965b1db0b7093897d1c54e12c08c51d581f59b179c669032f227e6ed76e58c`; the API also reported that image for the
earlier `b9ab9792` deployment. Effective settings showed one `us-west2` replica, `/health`, 45-second drain, 5 restart
retries and default `ON_FAILURE`. The original volume instance `49b76b29-1170-4c40-863a-30dd54d5cfc4` remained `READY`
at `/data`, 50,000 MB. Platform smoke after success passed 18 of 18 checks; the post-apply plan returned zero changes
and no diagnostics, with variables unmanaged. Read-only runtime verification matched package manifest
`sha256:647aa96417228de100571b996f7d0d0a4037d7af7d7982059b48874f7a0aa96b`, source
`f2c7b7f5077c01a52b8dd44eebc551a74eb945f6` (candidate `2d8d30d6`) and all 219 packaged runtime file hashes, with no
mismatches; Node was 24.22.0. No new application source was uploaded. The application remains 0.5.4; its original
upload included legacy JSON, while future packages from this source omit those files. These checks establish configuration,
package identity and public host behavior, not new application or money-path acceptance. See the
[apply and verification record](operations.md#railway-infrastructure-as-code).

**Earlier 0.5.4 deployment, 2026-11-08T22:17Z:** candidate `2d8d30d6` (commit `f2c7b7f`, the release candidate whose last gate
booted this package's image offline twice), Railway deployment `b9ab9792` on the `gateway` service (image
recorded then as `sha256:fd7992ae…`; the later API read returned `sha256:af965b1d…`, above; base `node:24.22.0-slim`),
deployed from a copy of the candidate's `platform` package identical
to it. It signs for `api.multiagency.ai` and started no hosted agents. At 22:17Z the platform smoke checks passed (18 of
18) and the confirm page's 6 assets were each fetched and byte-equal to the package's. Before it switched, the same
checks passed on 0.5.3.

**Earlier deployment, 2026-11-08 (04:54Z, 0.5.3):** the project's `gateway` service, synced into production from staging, so each
environment has its own instance with its own volume, variables, domain and deployments. Deployment `c34b1867`
(04:54Z, image `sha256:bb1d820b…`), built from the same upload of candidate `a434f381`'s package as `api` below
(snapshot `sha256:b45bdb10…`); it signs for `api.multiagency.ai`, and
`PLATFORM_URL=https://api.multiagency.ai pnpm smoke` passed all 16 checks at about 05:05Z. **Known shortcut:** the
sync copied staging's `NEAR_INTENTS_AGENT_API_KEY`, `FASTNEAR_API_KEY` and `SESSION_SECRET`, and both hosts keep
them, production app credentials included (user, 2026-11-08). So staging and production agents use one provider key:
revoking, rotating or retiring it (`api_key_retired`) stops both hosts' agents at once, both share its provider limits,
and a leak from staging exposes production's agents' provider access. FastNEAR's quota is shared the same way.
`SESSION_SECRET` signs sign-in sessions, which a headless host doesn't serve, and derives each hosted Payables agent's
contributor secret from the host and agent name, so the two hosts derive different ones. Separating them later means a
new value on one host and a restart of its gateway (Readiness, "Its own credentials"). This shortcut ended on
2026-11-25, when production got its own three values (above).

**First deployed 2026-11-07** as a separate service, `api` (deleted 2026-11-08 for the synced `gateway`): SDK 0.5.3's
`platform` package (candidate `a434f381`, commit `49b8d51`), Railway deployment `f181f44f` from 13:52Z (image
`sha256:20cb09b2…`; build log `containerimage.digest sha256:1e282aed…`; base `node:24.22.0-slim`, while the candidate
ran on 24.22.2). Before DNS, its Railway domain answered `/health` 200 and `/apps/v1/…` and `/confirm/…` 421, since it
signs only for `api.multiagency.ai`. Read-only checks on `api.multiagency.ai` at 14:19Z (Let's Encrypt certificate)
all passed: `/health` 200; `/apps/v1/agents/x` 401 without a credential and 403 with a browser `Origin`; `/`,
`/gw/challenge`, `/a/x/access` and `/build-manifest.json` 404; `POST /apps/v1/dao-consents` 401; the confirm page's
script `/static/js/lib-react.e499478f4d.js` 200; an unknown DAO's stop page 404 with no script, under `default-src
'none'`. No app credential issued, no owner, no hosted agent yet.

## Readiness

| Item | State | What it needs |
|---|---|---|
| First production release candidate | 0.5.3 introduced the shutdown grace, consent archiving, the monthly access log and provider SDK 0.8.0 (needed for a partner portal key). Candidate `a434f381` (commit `49b8d51`, Node 24.22.2) passed every gate on 2026-11-07; published to npm and tagged `sdk-v0.5.3` | Recorded for that release; a later release needs its own candidate |
| Staging evidence for that release | 0.5.3 ran on staging (`c3a2eb0b`, then `54fa8a24` with a partner portal key, 2026-11-07; read-only checks passed); one consent and one read through treasury.dev on 2026-11-07 ([platform staging](platform-staging.md)) | Recorded for that build; not evidence of a later release |
| Its own credentials | Separated 2026-11-25 (deployment `81e4cea7`): production's provider key, FastNEAR key and `SESSION_SECRET` differ from staging's; shared from 2026-11-08 until then (the known shortcut above) | Done. The new provider key is first exercised by the first production agent's read |
| Railway config | The owner applied corrected IaC on 2026-11-12 UTC; deployment, 18/18 smoke and package identity checks passed, with zero changes in the post-apply plan. Migration status reported no selected Config as Code path; the original 0.5.4 upload included legacy JSON, and the 0.6.0 package deployed 2026-11-25 carries none | Configuration verified; a future source-package upload remains a separate owner action ([operations](operations.md#railway-infrastructure-as-code)) |
| Treasury setup on production | `deploy/platform.json` sets up Payables only | A decision: add `treasury` to `appSetup` (DAO setup through apps is mainnet-observed on staging), or keep Payables only at first |
| Developer credentials | operator-issued ([developer access](developer-access.md)) | The first production credentials: the dashboard's and Treasury's, then requests by approval |
| Rollback | The previous deployment is `7a75ddcf` (0.5.9, `252cba1`), recorded above; the state directory was empty after the 0.6.0 swap, and a locked volume backup was taken 2026-11-25 (about 21:14Z); state-format compatibility still governs recovery | Review the exact previous image and retained state before redeploying. Preserve the original volume and records; configuration cutover is separate from application-state compatibility |
| Monitoring | `PLATFORM_URL=https://api.multiagency.ai pnpm smoke` checks it read-only (#37; passed all 16 checks on `gateway` 2026-11-08, about 05:05Z) | Run it after each deploy. `/health` is the gateway's liveness only: it stays 200 while an agent restarts or crash-loops, so watch the service's logs and restarts too |
| Memory | not sized | Each hosted agent is its own Node process: loading one agent's code took about 237 MB RSS (measured 2026-11-06 on macOS arm64, not on Railway). At the cap of 32 hosted agents that's about 7.6 GB beside the gateway. Set the service's memory limit for the agents you expect, and watch its usage on staging first |
| State growth | ended consents, the access log and, from 0.6.1, the intervention record (`.evidence/interventions.jsonl`, a line for every call that could act on an agent; each read loads it whole) grow with use | Run `pnpm app-credential archive-consents` weekly and `check-keys` on a schedule; move each finished month's `access-YYYY-MM.jsonl` off the volume; keep the intervention record whole, since a report's "no interventions" rests on it (never trim it inside a reported window); watch the volume's use (a full `/data` refuses every send and app call) |
| Shutdown grace | The earlier package declares `drainingSeconds: 45` in legacy JSON; the IaC candidate declares it under `deploy` | Verify the reviewed plan and post-apply configuration set 45 seconds. An agent waits up to 25 s for a send in flight; inspect shutdown logs after the owner-run deployment |

## Steps

Steps 1–2 record the original provisioning. Existing production keeps its original service, `/data` volume, settings
and records; do not repeat Sync or bootstrap to perform this migration. The source now supplies an IaC candidate whose
named `gateway` partial selects `api.multiagency.ai`, the existing `gateway-volume`, one `us-west2` replica, `/health`,
5 restart retries and 45-second drain. Variables are unmanaged by IaC, and the uploaded source is not replaced.
The SDK's public contract and app setup are unchanged. Before deploying the first package without `railway.json`, the
owner must perform the [staging and then production reviewed apply, with cutover only where required](operations.md#railway-infrastructure-as-code).
Run those tools from the reviewed source checkout with development dependencies; the production image does not
install the authoring SDK. The owner has applied both environments' configuration. Applying
configuration can redeploy the existing image without uploading new source, so the resulting deployment needs its own
status/log checks. Production ran earlier releases whose original upload included legacy JSON until 2026-11-25; the
0.6.0 package deployed then omits it.

1. In the platform's Railway project, production environment, bring in staging's `gateway` service with **Sync**
   (production as the receiving environment). Review the staged changes before deploying: Sync shows staging's whole
   service set and copies its variables, so remove `DASHBOARD_FILE` and replace staging's secrets (step 2), and keep
   any production service it would delete unless that's intended. It gets its own volume at `/data`; the initial
   packages' `railway.json` supplied one replica and healthcheck `/health`.
2. Variables: no `DASHBOARD_FILE` (the image defaults to `/app/deploy/platform.json`), `NEAR_INTENTS_AGENT_API_KEY`
   (the new production key), `NEAR_INTENTS_AGENT_API_URL`, `FASTNEAR_API_KEY`, and a new `SESSION_SECRET`. No
   `DAO_ENV`, `PAYOUT_ENV` or `RESTORE_*`.
3. After the infrastructure prerequisites above, the owner deploys the candidate's `platform` package from a copy
   outside any git repository:
   `cp -R <release>/platform /tmp/platform-<candidate>`, `cd` there, `railway link` (platform project, production,
   `gateway`), then `railway up --service gateway --environment production`. The build log shows the Dockerfile's
   steps. Follow the exact returned deployment ID to `SUCCESS`, verify its package/image identity and retained volume,
   then inspect hosted-agent logs and restarts. Startup can submit signatures from already-passed DAO votes and run
   persisted schedules: review retained owner actions and schedules before restarting; a smoke check does not require
   enabling them. Preserve any records that progress during startup.
4. Leave `DASHBOARD_HOST` unset: the service then signs only for `api.multiagency.ai`, so nothing can be signed for
   the Railway domain by mistake. On the Railway domain, `/health` answers 200 and `/apps/…` and `/confirm/…` answer
   421, which shows that binding. Add `api.multiagency.ai` as the service's custom domain (target port 8080), add the
   CNAME and the `_railway-verify` TXT record Railway lists at the DNS host, wait for the certificate, then run the
   checks below on `api.multiagency.ai`.
5. Read-only checks:
   - `/health` gives 200.
   - `/apps/v1/agents/x` gives 401 without a credential, and 403 with a browser `Origin`.
   - `/`, `/gw/challenge` and `/a/x/access` give 404.
   - One of the confirm page's own scripts gives 200: from the package copy,
     `node -p 'require("./web/dist/build-manifest.json").entries.confirm.initial.js[0]'`. Without that manifest the
     page renders blank (seen on staging 2026-11-06).
   - `POST /apps/v1/dao-consents` gives 401 without a credential.
6. Issue the first production credentials from the service's state directory (`cd /data/state &&
   /app/node_modules/.bin/tsx /app/src/app-credential.ts issue <deployment> api.multiagency.ai 90 "<name>"`) and deliver
   each privately ([developer access](developer-access.md)).
7. Record the deployment id, image digest, candidate and commit here, and the first real owner's consent with its date
   in the [mainnet log](mainnet-log.md).

## What production adds over staging

Real owners and real apps: a consent signed for `api.multiagency.ai` is valid only there, and credentials are bound to
that host. Same code and same limits: 1,200 requests an hour per credential, at most 32 hosted agents per host, and DAO
requests bounded per deployment.
