# Platform staging

A `staging` environment in the platform's Railway project serves app access for the dashboard's staging
(`dev.multiagency.ai`) at `api.dev.multiagency.ai`; production would be `api.multiagency.ai`. Consents and setups name
this host as their NEP-413 recipient, so it isn't renamed once owners have signed. Staging runs on mainnet (the provider
has no test network) with its own state and test agents, never the live demo hosts' records.

Staging is meant to run the `platform` package (`scripts/package-platform.mjs`, built by every release candidate beside
`dao`): the gateway as a headless host (`headless` in its config), which serves `/health`, app access (`/apps/v1`) and
the confirm page with its own assets, and answers 404 to everything else, before reading any session: no sign-in,
owner app, owner RPC, machine credentials or demo hosts. App setup is limited to the areas `appSetup` lists: Payables
only on the deployed staging host. From 2026-11-02 `deploy/platform-staging.json` lists Treasury too (not
deployed): an app sets up an Organization's own Treasury agent, as stack-tested in `test/e2e/app-access.spec.mjs`
(simulated provider and signatures); `deploy/platform.json` stays Payables only until a staging run of that path is
recorded. It has run it since 2026-10-31T01:03Z (release candidate `b9221b45`, commit `01add07`, Railway deployment
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
3. Deploy the release candidate's `platform` package from a copy outside any git repository. Inside this one,
   `railway up` uploads the repository's root, not the package (seen 2026-11-04): with its `.gitignore` that has no
   `Dockerfile`, so Railway falls back to Railpack and fails with "No start command detected", and without it the upload
   takes in `.test-artifacts/`. So `cp -R <release>/platform /tmp/platform-<candidate>`, `cd` there, `railway link
   --project <id> --environment staging --service gateway`, then `railway up --service gateway --environment staging`.
   The build log should show the Dockerfile's steps, and the upload is the package's size (about 0.9 MB for 0.5.0). To check before DNS, set
   `DASHBOARD_HOST` to the Railway domain, then point a CNAME for `api.dev.multiagency.ai` (Namecheap) at the domain
   `railway domain status` shows and remove `DASHBOARD_HOST`.
4. Read-only checks, all in `PLATFORM_URL=https://api.dev.multiagency.ai pnpm smoke` (#37; passed 2026-11-07):
   `/health` 200; `/apps/v1/agents/x` without a credential 401, with a browser `Origin` 403;
   `/`, `/gw/challenge` and `/a/x/access` 404; one of the confirm page's own scripts 200 (from the package copy,
   `node -p 'require("./web/dist/build-manifest.json").entries.confirm.initial.js[0]'`), since a package without that
   manifest serves the page blank (seen 2026-11-06). Another host gets 421 from the gateway (offline-tested in
   `test/platform-host.test.ts`), but through Railway's edge it can't be checked: a request for a host not attached to
   the service gets Railway's own 404 "Application not found" (`x-railway-fallback: true`, seen 2026-11-05) and never
   reaches the gateway. The smoke check also fetches every script and stylesheet the confirm page loads, which needs no
   package copy.
5. On the staging service, the operator issues the dashboard's credential from the gateway's own state directory (it
   writes `.app-access/` there, beside the gateway): `cd /data/state && /app/node_modules/.bin/tsx
   /app/src/app-credential.ts issue multiagency-dashboard api.dev.multiagency.ai 90 "MultiAgency dashboard"`. The token
   goes only into the dashboard staging's server secrets (`PLATFORM_APP_CREDENTIAL`, with
   `PLATFORM_URL=https://api.dev.multiagency.ai` and `PLATFORM_DEPLOYMENT=multiagency-dashboard`). Deployment names follow
   `<publisher>-<app>` and are the same on every host: the host separates staging from production, and a credential is
   bound to one host (provisional until the first real owner on production). `staging` is the
   platform's own test deployment (the stand-in runs below); a credential under it acts on that deployment's consents.
6. Rollback: redeploy the previous image; state stays on the staging volume. Nothing here touches proto.multiagency.ai
   or invoices.multiagency.ai.

Production (`api.multiagency.ai`, set up 2026-11-07: [platform production](platform-production.md)) is the same
package with `deploy/platform.json`, the image's default `DASHBOARD_FILE`: since 2026-11-08 the project's `gateway`
service, synced into the production environment, with its own volume and domain. It shares staging's provider key,
FastNEAR key and session secret, production app credentials included (a known shortcut, [platform
production](platform-production.md)); rotating or revoking one rotates both.

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
treasury agent; never scheduled. It settles the one open question of the Treasury proposals design
([enforcement](enforcement.md#treasury-proposals-offline--and-stack-tested)): whether a provider-held confidential swap's
`request_hash` covers what it buys and its floor. Nothing is swapped: the held swap is rejected.

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
3. In the agent's directory, run `pnpm inspect-held-swap <correlation id>` (read-only: it never sends, signs or votes;
   `src/inspect-held-swap.ts`, offline-tested in `test/held-swap.test.ts`). It reads `getStatus` (`details`, with
   `approval_id` and `dispatch_committed_at` if any), `getApproval` (`request_type`, `request_data`, `request_hash`,
   `expires_at`) and the confidential `balance_raw` and `available_raw` of the swap's assets, then recomputes sha256 of
   the canonical JSON of each candidate shape: `request_data` as given, with `kind` set to `request_type`, `{ amount,
   flow: "swap", kind: "confidential", min_amount_out, token, token_out }`, the same with `chain` and `to` where
   present, and `{ amount_in, kind: "swap", min_out, token_in, token_out }`. It prints which equals `request_hash`
   (`matched`, or null) and the outcome: `A` only if the matching shape names the input asset, amount, output asset
   and floor; otherwise `B`. It exits 1 without reading the approval if the operation isn't this agent's and held.
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

## A DAO-owned Treasury agent on staging (run 2026-11-04, steps 1–4 and 7: [mainnet log](mainnet-log.md#a-dao-owned-treasury-agent-through-an-app-on-platform-staging-2026-11-04-utc); 2026-11-05, steps 3, 5 and 6: [mainnet log](mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc))

User-run, on mainnet, through staging, never scheduled. It would be the first evidence of DAO owners through apps,
which so far is offline- and stack-tested against simulated votes only (`test/app-dao.test.ts`,
`test/e2e/app-access.spec.mjs`). What it would observe:
- whether a real Sputnik vote passes inside the provider intent's minutes
- whether FastNEAR's transaction API shows the `v1.signer` signature
- what Trezu shows voters
- what the provider answers for a DAO-owned hosted agent

**Before starting**
- **Staging runs 0.5.7's `platform` package (commit `cc90604`, #77).** Since 2026-11-11 (deployed 13:45Z, checked at
  15:57Z): candidate `23e51842`, Railway deployment `70b2f02e`, package manifest `sha256:b7c36778…` (created 13:40:52Z),
  with `deploy/platform-staging.json`; the image digest isn't recorded. It brings the 0.5.7 changes listed in
  [SDK changes](sdk-changes.md), among them a DAO's `market` consent covering its market agent's owner actions, one
  requestId per DAO hire, the signed-call request budget and per-Organization fair share (#59), one owner action of a
  kind at a time, and the cash floor in `overview`. The platform smoke checks passed (18 of 18), and its confirm page's
  6 assets were each fetched and byte-equal to the package's. Nothing on it has been exercised yet beyond those
  read-only checks.
- **Before that, 0.5.6's `platform` package (commit `f7caad4`, #61).** Since 2026-11-10 (checked at 22:38Z): candidate
  `36a66cb4`, Railway deployment `ffcb4120`, image `sha256:d5201b74…` (base `node:24.22.0-slim`), with
  `deploy/platform-staging.json`. It brings the 0.5.6 changes listed in [SDK changes](sdk-changes.md), among them market
  hires, recoverable hosted-agent release and the provider SDK 0.8.2. The platform smoke checks passed (18 of 18), and its
  confirm page's 6 assets were each fetched and byte-equal to the package's. Nothing on it has been exercised yet beyond
  those read-only checks.
- **Before that, 0.5.5's `platform` package (commit `2e7b1e6`, #57).** Since 2026-11-10 (checked at 00:36Z): candidate
  `d6ecd354`, Railway deployment `2328b6ad`, image `sha256:4013ff00…` (base `node:24.22.0-slim`), with
  `deploy/platform-staging.json`. It brings the 0.5.5 changes listed in [SDK changes](sdk-changes.md), among them
  consent nonces and the wallet-stop freeze, `payee_not_agreed`, the steward's removal and `phase` on owner actions. The
  platform smoke checks passed (18 of 18), and its confirm page's 6 assets were each fetched and byte-equal to the
  package's. Nothing on it has been exercised yet beyond those read-only checks.
- **Before that, commit `96a0bb6`'s `platform` package.** Since 2026-11-09 (checked at 16:17Z): candidate `49e3ead8`,
  Railway deployment `46380681`, image `sha256:7526873d…` (base `node:24.22.0-slim`), with
  `deploy/platform-staging.json`. It brings #45 (`treasury/get` reads a DAO's confidential setting from chain), #44
  (reads close a proposal whose agent or strategy changed) and #43 (a vote on a proposal that ended answers
  `proposal_not_open`). The platform smoke checks passed (18 of 18), and its confirm page's 6 assets were each fetched
  and byte-equal to the package's. On it, treasury.dev's DAO vote on an invalidated proposal, refused once a minute
  before, read `ended` at 16:06Z and stopped.
- **Before that, 0.5.4's `platform` package.** Since 2026-11-08 (checked at 22:05Z): candidate `2d8d30d6`, commit
  `f2c7b7f`, Railway deployment `e6e6e9f1`, image `sha256:3285a695…` (base `node:24.22.0-slim`), with
  `deploy/platform-staging.json` (the gateway signs for `api.dev.multiagency.ai`); its three hosted agents started. The
  platform smoke checks passed (18 of 18), and its confirm page's 6 assets were each fetched and byte-equal to the
  package's. The first candidate under the platform-only release script, whose last gate booted that package's image
  offline twice.
- **Before that, 0.5.3's `platform` package.** Since 2026-11-07 (checked at 04:27Z): candidate `a434f381`, commit
  `49b8d51`, Railway deployment `c3a2eb0b`, image `sha256:d2803f47…`, with `deploy/platform-staging.json`. Its confirm
  page's 22 assets were each fetched and byte-equal to the package's. Redeployed on the same image with the partner
  portal's key as deployment `54fa8a24` (2026-11-07T05:00Z; an earlier redeploy, `a2adbd16`, had the wrong key and
  every provider call answered `401 invalid_api_key`, with nothing sent). On it, through treasury.dev, the owner
  disconnected an existing Treasury agent and signed a new consent (read, treasury and owner; expires
  2027-02-05T09:26Z), and the agent's holdings and books read through the provider (2026-11-07, about 09:26Z). The strategy grant stayed in force across the reconnect. Before it, from 2026-11-06T21:16Z, staging ran
  `platform` packages built from a checkout, not from a release candidate: commit `6f8ecf0` (deployments `d4a7ac2f`
  and `73e2c2e7`), then commit `161ee1f` from 2026-11-07T02:48Z (deployment `4d7b6d77`, image `sha256:1ae21c41…`).
  Each is matched to its package by time (the package was made a few minutes before the deployment); Railway
  doesn't record the source. Before that, 0.5.2 from 2026-11-06 (checked at 15:44Z): candidate `d33f8f9b`, commit
  `ce5fec6`, deployment `5975d56f`, whose `appSetup` lists `treasury`.
  Before that, 0.5.1 with the proposal-hash fix from about 2026-11-05T04:12Z (candidate `956a0e55`, commit `8ce51c2`,
  deployment `3c085b20`, image `sha256:1870fb68…`), 0.5.1 from about 02:53Z (candidate
  `2b941c69`, commit `2223d11`, deployment `f417fc3a`, image `sha256:9fa854c9…`), and 0.5.0 from 2026-11-04T21:46Z
  (candidate `0263df8e`, commit `6ba0831`, deployment `bc635cb7`, image `sha256:5994c8f6…`).

  Read-only checks right after each deploy (all passed):
  - `/health` gives 200.
  - `/apps/v1/agents/x` gives 401 without a credential, and 403 with a browser `Origin`.
  - `/`, `/gw/challenge` and `/a/x/access` give 404.
  - `POST /apps/v1/dao-consents` gives 401 without a credential.
  - An unknown DAO's `/confirm/dao/stop/<dao>/<agent>` gives a 404 with an HTML page, no script, under
    `default-src 'none'`.

  It replaced `b9221b45`, which served Payables setup only.
- **A staging credential** for the platform's own test deployment `staging` (step 5 above).
- **The stand-in,** `scripts/staging-app.ts`, section "4. DAO owner" (2026-11-04):
  - It files DAO setup, consent and proposal votes, and prepares creation, the grant, freeze and unfreeze with
    `signer: "dao"`.
  - It shows each request's description and check link.
  - "Member signs the filed proposal" has the connected wallet sign and send exactly the transaction the platform
    answered: `proposalAndVote` when "member may vote" is ticked, `proposal` otherwise.
  - "Read request state" reads it. Section 5 calls any procedure, for the Treasury steps.
  - Its page script is syntax-checked and its server typechecks. It hasn't been run against the stack or staging yet.
- **The DAO** is `agentic.sputnik-dao.near`, whose policy passes a proposal with one member's vote. Its derived owner
  account (`v1.signer`, path `agent-owner`) already owns its agents on Treasury's own gateway. This run creates a new,
  separate hosted agent on staging.
- **Nothing else is waiting for that DAO's vote:** no owner action on Treasury's gateway is waiting either. One
  executor allows one waiting delegate per owner (`withDelegateLock`), but that doesn't span two executors. The
  provider blocks only a second open policy intent. Two executors with one owner are untested.
- **A member's wallet** that may propose and vote, and a small amount of USDC to fund the new agent. No other staging
  run in progress.

**Steps.** Record each step's UTC time and outcome.
1. **Set up.** File the DAO's setup (Treasury, at most 7 days). Open the check link from the description and confirm
   "it matches". The member files and votes. Read the setup's `state` until `reserved`. Record:
   - how long the vote took
   - how soon `findSignature` saw it
   - what Trezu showed
2. **Create.** `owner/prepare` with `{ type: "agent_create", role: "treasury" }` and `signer: "dao"`. The member files
   and votes within the intent's `expiresAt` (about 10 minutes). Read `owner/status` until `SUCCESS`, and `identity`
   until `created`. Record:
   - the standard
   - whether the vote passed in time
   - whether the DAO's derived account needed funding first (`signingRequest` refuses an unfunded account for a
     NEP-366 intent)
3. **Consent.** File the DAO's consent naming the new agent ID, with `read` and `treasury`. Vote, then read `state`
   until `signed`. Read `overview` under it.
4. **Grant.** Save a strategy (`strategy/save`), then `owner/prepare` with `{ type: "grant_issue", label: "treasury",
   expectedStrategyDigest }` and `signer: "dao"`. Check that the description names the strategy and its terms. Vote
   within the intent's minutes. Read `owner/status` until `SUCCESS`.
5. **Fund.** Take a deposit address (`deposit`, under `treasury`) and have the DAO send a small amount of USDC: build
   the calls with `fundingTransaction("USDC", address, amount)` and file them as one function-call proposal on the
   DAO, then vote. The DAO needs that USDC on its own NEAR account first; a confidential Trezu balance can't be sent this
   way. Read `overview` until the agent's confidential USDC shows the credit.
6. **Proposal.** Create a proposal for one small swap, then file the DAO's vote with `approve`. Check the description's
   swap and the check page. Vote, read `state` until `relayed`, then `proposals/execute`. Expect `executed`, with one
   swap whose floor is at least the signed one.
7. **Stop.** Turn autopilot on (`autopilot/enable` with the strategy's digest). Open
   `https://api.dev.multiagency.ai/confirm/dao/stop/agentic.sputnik-dao.near/<agent>`. The member files the shown
   proposal (Trezu's custom function call, or the whole transaction) and votes. Open the page again. Expect "stopped"
   with the consent revoked and autopilot off. Then expect the stand-in's calls under the consent to answer
   `forbidden`.
8. **Optionally, freeze and unfreeze** by DAO vote, each within minutes.

**Stop rules**
- A swap reading `unknown`, or `executing` that doesn't settle, is never retried. Stop and report.
- An owner intent that expires before its vote passes isn't prepared again until the late vote's proposal is
  rejected or expired, because a late signature could still be found. Record it.
- A refusal is recorded with its code.
- Afterwards the hosted agent remains, with any funds under its policy. The consent is already revoked by the stop.

**Record**
- **In `docs/mainnet-log.md`:** each step with the UTC date, the deployment id and the DAO proposal numbers.
- **In the private release record only:** op ids, transaction hashes, amounts and payees.
- **Then update the docs:** the inventory and the docs' "offline- and stack-tested" for the DAO path change only for
  what this run observed.

## A market hire on staging (rollout held; prepared, not run)

**0.5.9 rollout remains held. Do not start a 0.5.9 market executor or run the live steps below.** First stop all
writers sharing its state and audit submitted 0.5.6 through 0.5.8 unbound top-ups, retained payment-key funds and
pending x402 payments, preserving the complete state and key as described in [operations](operations.md).
The deployed provider route must supply a destination transaction and an independently verifiable final receipt;
affected keys need a separately reviewed recovery design. The exact 0.5.9 package, consumer and image gates also
remain open ([change notes](sdk-changes.md#059-unreleased)). These source checks do not clear the hold.

While the hold remains, inspect the preserved records and, where the existing host supports it, read
`market/status` with the original `requestId`. Do not start an executor just to obtain status or call `market/hire`
to resume a request. Status may reconcile receipt evidence; it does not resume an unsubmitted funding leg or resend
an attempted x402 payment.

This is a prepared plan for an owner-run mainnet observation with small amounts of the owner's own USDC and NEAR;
never scheduled. After the rollout hold is cleared, it would exercise the market path through the platform end to
end ([agent market](market.md)): a market agent set up and created through an app, the owner's consent and grant,
its payment key registered and funded, one x402 hire paid on delivery, and the payment's outcome read from the chain.
That platform run has not occurred. The proposed hire would use the owner's listed agent `multi` on market.near.ai,
so the owner would also perform the worker's step; the earlier observations used the local prototype (Spikes in market.md).

**Before starting, only after the rollout review clears the hold**
- Staging runs a `platform` package whose `deploy/platform-staging.json` lists `market` in `appSetup` (0.5.6 brings the
  market code; this file brings the area).
- A credential for the platform's test deployment `staging` (step 5 above, with `staging` as the deployment name).
- An owner wallet whose key is a full-access key of the owner account, signing NEP-413 and, on the confirm page, NEP-366.
- `multi` priced low with a short window on market.near.ai (it was $0.10 and 10 minutes for the spikes), and its agent
  token in the prototype's `~/agencies/market/.env` (`MARKET_AGENT_TOKEN`).
- Funds for the agent: USDC at least the price, and wNEAR of at least 0.02 NEAR plus margin (the first hire opens the
  payment key's account with a 0.02 NEAR top-up).
- No other staging run in progress.

**Conditional future steps, only after the hold is cleared and the owner chooses to run them.** Record each step's
UTC time and outcome.
1. Start the stand-in: `PLATFORM_URL=https://api.dev.multiagency.ai PLATFORM_APP_CREDENTIAL=tap_… PLATFORM_DEPLOYMENT=staging
   ORGANIZATION=org_market pnpm exec tsx scripts/staging-app.ts`, open `http://127.0.0.1:4318/` and connect the wallet.
2. Area `market`: "Sign setup text", then "Create the agent". Creation opens the confirm page: check it shows the market
   policy (`actions` withdraw only; assets USDC and wNEAR; one withdrawal destination, the payment key's account) and sign
   twice. Read the owner status until `SUCCESS`.
3. Scopes `owner`, `read` and `market` (not `payout`): "Sign consent". Expect it stored.
4. "Issue payout grant" with the area still `market`: it issues a `market` grant. Read the owner status until `SUCCESS`.
5. Call `market/account` (input `{}`). Expect `registered: false`, `opened: false`, and a `registration` transaction.
   Register the key from the owner's wallet:
   `near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit
   json-args '{"account_id":"<account>","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR'
   sign-as <owner> network-config mainnet sign-with-keychain send`. Call `market/account` again: `registered: true`.
6. Fund: call `deposit` with `{"asset":"nep141:wrap.near"}` and with `{}` (USDC), and send to each address (with its memo,
   above its minimum, before it expires). "Refresh view" until both show in the agent's balances.
7. Call `market/quote` with `{"handle":"multi","brief":"Staging hire\nReply with OK."}`. Copy the answer: these are the
   terms the owner approves (price, the market's payee, the window).
8. Once authorized by that review, call `market/hire` once with
   `{"requestId":"s-1","brief":"Staging hire\nReply with OK.","approved":<the quote>}`. It may first return `funding` or
   `funding_review` without a `taskId`: a bound hire can have a recorded top-up before any x402 payment exists.
   Follow the same `requestId` with `market/status`; stop for `funding_review` under the rules below. Provider
   `SUCCESS` or a visible balance alone does not prove that funding landed. Only proceed to the worker step when
   status reports the recorded payment's `taskId`; `unknown` describes an unsettled payment, not a completed hire.
9. Only after that payment and `taskId` exist, as `multi`'s worker in another terminal:
   `cd ~/agencies/market && T=$(grep '^MARKET_AGENT_TOKEN=' .env | cut -d= -f2-)`, then
   `curl -sS "https://market.near.ai/v1/agents/me/assignments?status=all&limit=5" -H "authorization: Bearer $T" | jq '.assignments[] | {id: .assignment.assignmentId, status: .assignment.status, title: .job.title}'`;
   for the `in_progress` one titled "Staging hire",
   `curl -sS -X POST "https://market.near.ai/v1/assignments/<id>/submit" -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"deliverableMarkdown":"OK: staging hire delivered."}'`,
   then `unset T`. Its id should equal the `taskId` from step 8.
10. Follow `market/status` with `{"requestId":"s-1"}` until a recorded payment is `paid`, with its deliverable, or a
    stop rule applies. Compare `market/account` with the private before-run record, accounting separately for any
    retained funding; a balance change does not replace the bound final receipt proof.

**Stop rules**
- Stop at anything step 2's confirm page shows that isn't the market policy.
- Stop at `funding_review`, including a lost funding acceptance reply or a provider outcome without final landing
  proof. Preserve the original request, funding journal, evidence and payment key for review. Do not use a new ID,
  rotate the key, clear its reservation or treat `allowBalance` as clearance.
- While status reads `funding` or `unknown`, follow only the original `requestId`; never hire the same thing under a
  new ID. Status does not resume an unsubmitted leg. If an unused x402 payment authorization expires, `not_charged`
  concerns that payment only: it does not prove that earlier top-ups were absent or returned.
- A refusal (`state: "refused"`, or a `refused` result) sends no new x402 payment, but earlier recorded top-ups may
  remain retained. Read its `code` and the same request's status, and preserve that funding for review.

**Record**
- **In `docs/mainnet-log.md`:** each step with the UTC date and the deployment id.
- **In the private release record only:** op ids, transaction hashes, amounts, the payment key's account and the payee.
- **Then update the docs:** market.md's status and enforcement's "not yet observed through the platform" change only
  for what this run observed.
