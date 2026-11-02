# Platform staging

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

## Staging evidence on a test agent (run 2026-10-28: [mainnet log](mainnet-log.md#app-access-on-platform-staging-2026-10-28-utc))

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

## What a held swap's approval commits to (prepared, not run)

User-run, on mainnet, on an isolated test agent the laptop CLI owner creates for it (as on 2026-10-13, [mainnet
log](mainnet-log.md#isolated-test-agent-shield-and-monthly-cap-2026-10-13t0327z)), never a production, staging-hosted or
treasury agent; never scheduled. It settles the one open question of the durable-proposals design (the workspace's
`coordination/durable-proposals.md`, section 2a): whether a provider-held confidential swap's `request_hash` covers what
it buys and its floor. Nothing is swapped: the held swap is rejected.

Before starting: the isolated agent's policy, signed with `pnpm update-policy --policy <file>`, allows `swap`, is
`confidential`, has `owner_approval` on, lists USDC and wNEAR in `assets`, and has per-transaction, hourly, daily and
monthly USDC caps and a USD budget just above one tiny swap; a `treasury` grant (`pnpm issue-grant treasury`); a few
cents of USDC deposited confidential; its own state directory, executor on, autopilot off; no other run on it.

1. Read the starting state: `pnpm inspect` (policy revision, balances, grants). Record the confidential and `available`
   USDC.
2. Plan one USDC → wNEAR swap with the agent's own executor: `externalPlan` with a single swap of the tiny amount, then
   `executePlan` with its id, from the owner's own session on that local executor. The swap goes through `dispatch`,
   the journal and `authorize` like any other. Expect the plan's event to read `PENDING_APPROVAL` and the plan to stop
   there; the journal holds the operation as held (it doesn't block sends).
3. Read, with the provider API on the agent's directory: `getStatus` of its correlation id (`details`, `approval_id`,
   `dispatch_committed_at` if any, `expires_at`), `getApproval` (`request_type`, `request_data`, `request_hash`,
   `expires_at`) and `getBalances` (`balance` and `available` for USDC). Recompute sha256 of the canonical JSON of each
   candidate shape: `{ amount, flow: "swap", kind: "confidential", min_amount_out, token, token_out }` from
   `request_data`, the same with `chain` or `to` where present, and `{ amount_in, kind: "swap", min_out, token_in,
   token_out }`. Record which equals `request_hash`, or that none does.
4. Reject it: prepare an `approval_vote` with verdict `reject` for that approval and sign it as the owner (approving
   any held swap is refused before signing). Read the status until it ends: expect `FAILED`, reason rejected, and the
   balances unchanged.
5. Record it in `docs/mainnet-log.md`: date (UTC), the shapes compared and which matched, whether the hash covers the
   output asset and floor, the approval's lifetime, and whether `available` excluded the held amount. Op ids, hashes'
   inputs, amounts and payees go only in the private release record.

Stop rules: the swap reading anything but `PENDING_APPROVAL` after step 2 (a policy that didn't hold it), or an
unknown outcome: stop, don't reject or resend, and report. Not checked by this run: what the wallet shows for a swap
vote, and whether an approved swap is held to the floor (approving one isn't built).

## Staging withdrawals on the same test agent (run 2026-10-30: [mainnet log](mainnet-log.md#payout-withdrawals-on-platform-staging-2026-10-30-utc))

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
