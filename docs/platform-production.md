# Platform production: app access on api.multiagency.ai

The runbook for putting app access (`/apps/v1`) into production. Prepared 2026-11-05; **set up 2026-11-07** by the
user (below); every step here is the user's to take. It's the same `platform` package staging runs ([platform
staging](platform-staging.md)), with `deploy/platform.json` (host `api.multiagency.ai`, headless, app setup for
Payables only, no configured agents). The production environment's earlier prototype services (`dao`, `invoices`,
`invoices-frontend`, `payables`, `treasury`) were deleted on 2026-11-08; the user stated their agents were empty (not
checked: no balances, journals or agent lists were read); proto.multiagency.ai, invoices.multiagency.ai,
payables.multiagency.ai and treasury.multiagency.ai no longer answer.

**Running since 2026-11-08:** the project's `gateway` service, synced into production from staging, so each
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
new value on one host and a restart of its gateway (Readiness, "Its own credentials").

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
| A release candidate on the commit to ship | 0.5.3 is the build to ship: it has the shutdown grace, consent archiving, the monthly access log and provider SDK 0.8.0 (needed for a partner portal key). Candidate `a434f381` (commit `49b8d51`, Node 24.22.2) passed every gate on 2026-11-07; published to npm and tagged `sdk-v0.5.3` | Done |
| The same build observed on staging | staging runs 0.5.3 (`c3a2eb0b`, then `54fa8a24` with a partner portal key, 2026-11-07; read-only checks passed); one consent and one read through treasury.dev on 2026-11-07 ([platform staging](platform-staging.md)) | Done |
| Its own credentials | shared with staging since 2026-11-08: the sync copied staging's provider key, FastNEAR key and `SESSION_SECRET`, kept for production app credentials too (user, 2026-11-08; the risk is in the known shortcut above) | Not required before production app credentials. To separate later: a production partner portal key, a production FastNEAR key and a new `SESSION_SECRET` on production's `gateway`, then the read-only checks |
| Railway config | `railway.json` still works until 2026-12-01; the first deploy used it (2026-11-07) | Any deploy after 2026-12-01 needs the migration ([operations](operations.md#railway-config-as-code-ends-2026-12-01)) |
| Treasury setup on production | `deploy/platform.json` sets up Payables only | A decision: add `treasury` to `appSetup` (DAO setup through apps is mainnet-observed on staging), or keep Payables only at first |
| Developer credentials | operator-issued ([developer access](developer-access.md)) | The first production credentials: the dashboard's and Treasury's, then requests by approval |
| Rollback | nothing earlier to roll back to | For later releases, redeploy the previous image; its state stays on its own volume. Never delete or restore backend records |
| Monitoring | `PLATFORM_URL=https://api.multiagency.ai pnpm smoke` checks it read-only (#37; passed all 16 checks on `gateway` 2026-11-08, about 05:05Z) | Run it after each deploy. `/health` is the gateway's liveness only: it stays 200 while an agent restarts or crash-loops, so watch the service's logs and restarts too |
| Memory | not sized | Each hosted agent is its own Node process: loading one agent's code took about 237 MB RSS (measured 2026-11-06 on macOS arm64, not on Railway). At the cap of 32 hosted agents that's about 7.6 GB beside the gateway. Set the service's memory limit for the agents you expect, and watch its usage on staging first |
| State growth | ended consents and the access log grow with use | Run `pnpm app-credential archive-consents` weekly and `check-keys` on a schedule; move each finished month's `access-YYYY-MM.jsonl` off the volume; watch the volume's use (a full `/data` refuses every send and app call) |
| Shutdown grace | `drainingSeconds: 45` in the package's `railway.json` | Nothing: an agent stops sending on SIGTERM and waits up to 25 s for a send in flight. Check after the first deploy that the old deployment stopped cleanly (its log shows no "still running" line) |

## Steps

1. In the platform's Railway project, production environment, bring in staging's `gateway` service with **Sync**
   (production as the receiving environment). Review the staged changes before deploying: Sync shows staging's whole
   service set and copies its variables, so remove `DASHBOARD_FILE` and replace staging's secrets (step 2), and keep
   any production service it would delete unless that's intended. It gets its own volume at `/data`; the package's
   `railway.json` sets one replica and healthcheck `/health`.
2. Variables: no `DASHBOARD_FILE` (the image defaults to `/app/deploy/platform.json`), `NEAR_INTENTS_AGENT_API_KEY`
   (the new production key), `NEAR_INTENTS_AGENT_API_URL`, `FASTNEAR_API_KEY`, and a new `SESSION_SECRET`. No
   `DAO_ENV`, `PAYOUT_ENV` or `RESTORE_*`.
3. Deploy the candidate's `platform` package from a copy outside any git repository:
   `cp -R <release>/platform /tmp/platform-<candidate>`, `cd` there, `railway link` (platform project, production,
   `gateway`), then `railway up --service gateway --environment production`. The build log shows the Dockerfile's
   steps, and the upload is about 0.9 MB.
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
