# Platform production: app access on api.multiagency.ai

The runbook for putting app access (`/apps/v1`) into production. Prepared 2026-11-05; **not set up**: deploys are
paused, and every step here is the user's to take. It's the same `platform` package staging runs
([platform staging](platform-staging.md)), with `deploy/platform.json` (host `api.multiagency.ai`, headless, app setup
for Payables only, no configured agents). Production's `dao` service (proto.multiagency.ai) and `invoices` are
unchanged by it.

## Readiness

| Item | State | What it needs |
|---|---|---|
| A release candidate on the commit to ship | 0.5.3 is the build to ship: it has the shutdown grace, consent archiving, the monthly access log and provider SDK 0.8.0 (needed for a partner portal key). Candidate `a434f381` (commit `49b8d51`, Node 24.22.2) passed every gate on 2026-11-07; published to npm and tagged `sdk-v0.5.3` | Done |
| The same build observed on staging | staging runs 0.5.3 (`c3a2eb0b`, 2026-11-07; read-only checks passed) | One consent and one read on staging |
| Its own credentials | none issued | A new provider key for production from the partner portal (keys from before the portal are being retired: [credential rotation](credential-rotation.md)), a new FastNEAR key and a new `SESSION_SECRET`. None reused from `dao`, so the outstanding [credential rotation](credential-rotation.md) for `dao` doesn't touch this service; that rotation still needs doing |
| Railway config | `railway.json` still works until 2026-12-01 | A first deploy before then works as staging's did; any deploy after needs the migration ([operations](operations.md#railway-config-as-code-ends-2026-12-01)) |
| Treasury setup on production | `deploy/platform.json` sets up Payables only | A decision: add `treasury` to `appSetup` (DAO setup through apps is mainnet-observed on staging), or keep Payables only at first |
| Developer credentials | operator-issued ([developer access](developer-access.md)) | The first production credentials: the dashboard's and Treasury's, then requests by approval |
| Rollback | a new service, so nothing to roll back to | Stop or remove the service; its state stays on its own volume. For later releases, redeploy the previous image; never delete or restore backend records |
| Monitoring | `pnpm smoke` reads proto and invoices | Add `api.multiagency.ai`'s read-only checks to it, or run them after each deploy. `/health` is the gateway's liveness only: it stays 200 while an agent restarts or crash-loops, so watch the service's logs and restarts too |
| Memory | not sized | Each hosted agent is its own Node process: loading one agent's code took about 237 MB RSS (measured 2026-11-06 on macOS arm64, not on Railway). At the cap of 32 hosted agents that's about 7.6 GB beside the gateway. Set the service's memory limit for the agents you expect, and watch its usage on staging first |
| State growth | ended consents and the access log grow with use | Run `pnpm app-credential archive-consents` weekly and `check-keys` on a schedule; move each finished month's `access-YYYY-MM.jsonl` off the volume; watch the volume's use (a full `/data` refuses every send and app call) |
| Shutdown grace | `drainingSeconds: 45` in the package's `railway.json` | Nothing: an agent stops sending on SIGTERM and waits up to 25 s for a send in flight. Check after the first deploy that the old deployment stopped cleanly (its log shows no "still running" line) |

## Steps

1. In the platform's Railway project, production environment, add one empty service, `gateway`, with its own volume
   at `/data`, one replica, healthcheck `/health`.
2. Variables: no `DASHBOARD_FILE` (the image defaults to `/app/deploy/platform.json`), `NEAR_INTENTS_AGENT_API_KEY`
   (the new production key), `NEAR_INTENTS_AGENT_API_URL`, `FASTNEAR_API_KEY`, and a new `SESSION_SECRET`. No
   `DAO_ENV`, `PAYOUT_ENV` or `RESTORE_*`.
3. Deploy the candidate's `platform` package from a copy outside any git repository:
   `cp -R <release>/platform /tmp/platform-<candidate>`, `cd` there, `railway link` (platform project, production,
   `gateway`), then `railway up --service gateway --environment production`. The build log shows the Dockerfile's
   steps, and the upload is about 0.9 MB.
4. Before DNS, set `DASHBOARD_HOST` to the Railway domain and run the read-only checks below against it. Then point a
   CNAME for `api.multiagency.ai` at the domain `railway domain status` shows, remove `DASHBOARD_HOST`, and run them
   again on the real host.
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
