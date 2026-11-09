# MultiAgency platform

Control plane for agentic treasuries, built on NEAR Intents.

An AI agent moves a wallet's or a Sputnik DAO's funds on [NEAR Intents](https://near.org/intents) mainnet, only inside
a policy its owner signed. The provider, the [NEAR Intents Agent API](https://api.agentsonintents.com/llms.txt), holds
the funds and enforces that policy. This platform adds what the provider can't: owner sign-in and consent, checks before
each send, at-most-once execution with recovery, and verified owner and DAO approvals. A DAO owner can be a
[Trezu](https://trezu.org) treasury.

> Runs on NEAR mainnet with real funds. Use a low-value account and small amounts.

**Reviewing it?** Start with [docs/review.md](docs/review.md): each claim, how it is known, and where the evidence is.

## The product

The platform host (the headless `platform` package: [staging](docs/platform-staging.md),
[production](docs/platform-production.md)) and `@multiagency/sdk`, through which apps reach it over `/apps/v1` with the
owner's consent ([app access](docs/app-access.md), [integration path](docs/integration-path.md)). Its core is two loops:

| Loop | What it does | Details |
|---|---|---|
| **Treasury** | An agent rebalances toward the owner's target, quoting every swap, inside per-asset caps and a USD budget the owner signed; each proposal is approved by the owner's signature or the DAO's vote, or autopilot runs under a grant bound to the saved strategy | [docs/treasury.md](docs/treasury.md) |
| **Payouts** | An app requests a payout once under its own id; under a policy that holds payments, the provider holds it for the owner's vote; it is paid confidentially, or withdrawn to an agreed NEAR account. Wallet owners only: a DAO's consent covers Treasury, not payouts | [docs/facilitator.md](docs/facilitator.md) |

This repository is meant to be the one owner of the gateway, executor and money path, with apps (Treasury, Payables,
Invoices, the MultiAgency dashboard) building on it only through `@multiagency/sdk`. Not yet: Payables still carries its own
copy (see Not done yet).

**Experimental**, outside the core loops: no compatibility promise, and offline-tested unless their page says otherwise.
The [dashboard prototype](docs/prototype.md) (the `dao` and `invoices` source, whose hosted services were retired and whose packages are no longer
built, 2026-11-08) with its invoices, agreements, work orders, guided walkthroughs and Telegram notifications;
[agent connections](docs/agent-access.md); and the run-log adapter. The LLM steward was removed in SDK 0.5.5: the
platform keeps no model of its own in the money path.

## How it works

- The **owner** signs a **policy**: allowed actions, assets, caps, budget, and where funds may go.
- The owner issues a **grant** that lets this server act for the **agent** inside that policy.
- The agent swaps, shields and pays through the Agent API and OutLayer, with application checks and
  provider-enforced limits. Output-asset enforcement is local. The executor sends one operation at a time
  and waits for each to settle, so its own simultaneous requests can't overrun a cap or the USD budget
  (offline-tested against a simulated provider); against other senders, strict cumulative per-asset
  enforcement and USD-budget atomicity rest on the provider and remain unproven. See the
  [enforcement assessment](docs/enforcement.md#spending-limits-under-concurrency) for the evidence and
  remaining gaps.
- Every policy has a **mandate digest**: sha256 of its canonical JSON (`src/mandate.ts`), which anyone
  holding the policy can recompute. Every plan and every money action records the digest it ran under.
- The **books** compare public balances against the chain's
  `intents.near` transfers (FastNear's Transfers API), confidential ones against the API's recorded
  executions. Differences are unexplained: external credits, incomplete records or observation timing
  can cause them. This is not independent proof of confidential custody. `pnpm books` prints them,
  and `pnpm books --csv` exports the ledger.

How the money path keeps these safe (one send site, the journal, reconciliation, owner intents, invoice
storage and the checks before each send) is in [docs/architecture.md](docs/architecture.md#how-the-money-path-stays-safe-on-one-host).

## Run it

```sh
pnpm install
cp .env.example .env   # add an API key from https://partners.demo.agentsonintents.com
pnpm demo              # dashboard on http://localhost:8787
```

That runs the experimental dashboard prototype. To build an app on the platform, run the local stack instead:
`pnpm build:web && pnpm test:e2e:stack --app <deployment> --no-browser` (simulated provider and chain, an app credential
issued at startup; see the [integration path](docs/integration-path.md)).

The dashboard walks you through creating an agent and issuing its grant, and runs every money action.
The command line has only what the dashboard doesn't: owner actions signed with a local key, and checks.

| Owner actions, signed with `AGENT_OWNER_PRIVATE_KEY` instead of a wallet or DAO vote | |
|---|---|
| `pnpm create-agent` | Creates an agent with the policy in `src/policy.ts` and saves `AGENT_ID` |
| `pnpm issue-grant [treasury\|payout\|invoices] [suffix]` | Issues a grant and saves its token |
| `pnpm revoke-grant [grant id]` | Lists live grants, or revokes one |
| `pnpm update-policy [--policy file] [--diff]` | Prints the change from the policy in force, then signs it without asking; `--diff` only prints |
| `pnpm archive` | Freezes, then archives the agent (reversible) |

| Checks | |
|---|---|
| `pnpm inspect [--whoami]` | The agent's policy, balances and grants, as the API returns them |
| `pnpm reconcile [--poll]` | Operations without a proven outcome; `--poll` reads their statuses once, resending nothing |
| `pnpm books [--csv]` | Balances against chain transfers and recorded executions; `--csv` prints the ledger |
| `pnpm smoke` | Read-only check of the hosted dashboard and invoice page (`DASHBOARD_URL`, `INVOICES_URL`) and of a platform host (`PLATFORM_URL`); set any of them |
| `pnpm run-report` | The unattended-run report ([unattended run](docs/unattended-run.md)) |

## Test and deploy

`pnpm verify` runs the complete offline sequence: typecheck, the offline suites, the browser suites (install the pinned
browser once with `pnpm exec playwright install chromium`), the isolated application stack with simulated provider,
chain and wallet, and the evidence drift check. CI runs it on every push to `main` and every pull request. See
[test boundaries and harnesses](docs/testing.md).

Each agent has exactly one executor host; the local lease doesn't enforce that across machines, so any other instance
runs `EXECUTOR=off` (approve-only). Deployment, executor migration and state preservation are in the
[operations guide](docs/operations.md).

## DAO ownership

A DAO has no keys, but it can sign through NEAR's MPC network. The owner is an account whose only
key is derived from the DAO, so every owner action becomes a DAO proposal calling `v1.signer.sign`.
When the vote passes, the server picks up the signature and submits it. The Agent API needs no
changes. See `src/dao-owner.ts`.

The recorded DAO ownership checks and their evidence limits are in the
[demo verification table](DEMO.md#what-is-verified).

A confidential Trezu treasury funds its agent with a payment from its confidential balance to
`nearcom:<the agent's wallet account>`, which the Funding page links to. Without the `nearcom:`
prefix, Trezu sends the payment out as a public withdrawal.

## Checking the claims

[docs/review.md](docs/review.md) summarizes each claim and how it is known. Each area's doc maps every requirement to its
evidence: [Payables](docs/facilitator.md), [Treasury](docs/treasury.md). Every dated mainnet run, with its DAO proposal
numbers, is in [docs/mainnet-log.md](docs/mainnet-log.md); operation ids and amounts are in a private record, available to
reviewers on request.

The app and the area tables use one [canonical requirement/evidence inventory](evidence/inventory.ts). Edit it, then run
`pnpm evidence:write`; `pnpm evidence:check` and `pnpm test` reject stale generated sections. Record new mainnet
observations in [the dated log](docs/mainnet-log.md), then reference them in the inventory. Keep private release details
out of both.

## Not done yet

Each line is a gap; the linked page says how the rest is known. The
[enforcement assessment](docs/enforcement.md#status) tracks the signed spending envelope.

**Apps and the platform**
- `MultiAgency/payables` and `MultiAgency/treasury-prototype` (not archived) still carry their own copies of the
  gateway and money path, so a fix here doesn't reach them; Payables' frontend still imports from its copy. The
  Treasury app (`MultiAgency/treasury`) is to replace the prototype and this platform's Treasury pages.
- The owner session (`/a/<agent>/`, the `dao` package's owner app, `ownerClient` and `/gw/agents`)
  has had no production host since 2026-11-08; owner UIs move to app access (platform#14). It stays until the apps
  replace it: Treasury's app-server pages (MultiAgency/treasury#138) and a Payables owner UI on `/apps/v1`, which doesn't
  exist yet: as of 2026-11-08, `MultiAgency/payables` (last commit 2026-10-19) uses only the owner session, and no
  branch of `MultiAgency/dashboard` calls app access, although staging holds its credential. Until then a wallet
  owner of a Payables agent has no hosted owner UI, only the stop page with no app. Contributor intake (the payee pages
  and Invoices) has no hosted path either: the headless host doesn't serve it, and app access leaves agreements,
  invoices and work orders out by design, so a Payables app keeps those records itself.
- A payee can read their own terms in the policy from the platform host under the owner's payee disclosure
  (platform#51, offline-tested, not deployed), but the answer is the platform's word, not independently checkable or
  signed, and DAO owners can't disclose
  ([app access](docs/app-access.md), [enforcement](docs/enforcement.md#a-payees-view-of-their-own-terms-offline-tested)).
- A new prototype must reuse a fixed host `demo` value and agent area; owner-app `contract.json` is checked at runtime
  only on hosts served by the shared release server (offline-tested, not deployed). See the
  [integration path](docs/integration-path.md#gaps).
- Payables' frontend (`97ddec7`, 2026-10-16) passes the source contract preflight only; its build isn't in the
  real-stack E2E suite. See
  [consumer compatibility](docs/shared-frontend-integration.md#consumer-source-contract-preflight).
- App access (`/apps/v1`) runs in production on api.multiagency.ai since 2026-11-07, with no app credential issued yet
  ([platform production](docs/platform-production.md)). Mainnet-observed on staging: confidential USDC payouts (2026-10-28) and
  withdrawals of wNEAR or USDC to agreed NEAR accounts (2026-10-30), and DAO-owned agents (below) ([mainnet log](docs/mainnet-log.md)).
  Approving a held withdrawal is offline- and stack-tested, not mainnet-observed, and its signature doesn't bind
  `destination_asset` ([enforcement](docs/enforcement.md)); at most 32 hosted agents per host, and at most 16 Organization agents per app deployment on a host, over its whole lifetime: a hosted agent is never released (#46). A dishonest app can still get a blind NEP-366 signature
  by having the owner sign the confirm link's text on its own page; a held payout's vote text names no payee or amount,
  so the app's display is the only place the owner sees them; an owner who signs the platform's sign-in text on an
  app's page gives it a full session; a service credential is a bearer. See [app access](docs/app-access.md).
- A second payout of an invoice already paid, under another `requestId`, is held for the owner's vote, the only check
  left. Found by the [crash test](docs/crash-test.md) of an outside agent (stack-tested with scripted agents; no model run
  recorded yet); see [enforcement](docs/enforcement.md#recovery-limitation).
- Treasury proposals (`treasury`, `treasury-execute`) are offline- and stack-tested for wallet owners; for a DAO owner,
  one proposal approved by vote and executed is mainnet-observed on staging (2026-11-05). The production platform
  configuration (`deploy/platform.json`) doesn't set up Treasury agents yet; staging's does. A proposal's approval is the platform's check, not the provider's: whoever holds
  the treasury grant can swap within the policy without it. Held swaps aren't used: what their vote commits to is
  unobserved ([enforcement](docs/enforcement.md#treasury-proposals-offline--and-stack-tested)).
- Whether a linked DAO is confidential (`treasury/get`) relies on Trezu's convention: its confidential setup registers
  the DAO's MPC key at the DAO's own name on `intents.near` (Trezu's backend source; both keys read alike for one DAO on
  mainnet, 2026-11-08). A DAO set up some other way, or under a path Trezu changes to, reads `false`. Set up for
  confidential intents, a DAO can still act publicly. Stack-tested; the platform's read itself isn't mainnet-observed.
- DAO-owned agents through apps: setup, creation, consent, the grant and the DAO's own stop are mainnet-observed on
  platform staging (2026-11-04, [mainnet log](docs/mainnet-log.md#a-dao-owned-treasury-agent-through-an-app-on-platform-staging-2026-11-04-utc)), and so are funding through an app (`deposit` under
  `treasury`, from 0.5.1) by the DAO's vote and an app's swap proposal approved by DAO vote and executed (2026-11-05,
  [mainnet log](docs/mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc)). Freeze and unfreeze by DAO vote are offline-tested only. The provider's owner intents (creation, grant, freeze) expire in 600 s or about 290 s (provider docs),
  so only a DAO whose vote passes that fast completes them; a slower DAO can approve swaps one proposal at a time but
  can't turn on autopilot (#20). A DAO's own stop (no app) ends what was given before it is applied; that happens only
  when someone opens its page after the vote, and the provider grant stands, so a consent the DAO gives later can turn
  autopilot on again. See [app access](docs/app-access.md).
- A wallet owner's own stop (no app; `/confirm/wallet/stop`) ends app consents and turns autopilot off for one agent or
  all of the wallet's, offline- and browser-tested with a stand-in wallet, not deployed; signing with a real wallet is untested. It
  doesn't revoke the grant. From 0.5.5 it may also freeze the agents, the owner's wallet signing the provider's freeze
  intent on the page within its 600 s window; no freeze, from this page or any other, is recorded on mainnet, and
  unfreezing still needs an app or the owner session ([app access](docs/app-access.md)).
- Agent connections exist only for a contractor's own reports (offline- and stack-tested, not deployed); a token is a
  bearer for at most 24 hours; owner connections aren't built. See
  [agent access](docs/agent-access.md#agent-connections-contractor-reports).
- A provider failure while preparing an owner action reaches the caller as `unknown`; nothing was signed or sent, and
  retrying prepares a new intent (seen on staging 2026-10-30). The deployed staging and production builds predate two
  source changes after 2026-10-30 ([errors at the RPC boundary](docs/architecture.md#errors-at-the-rpc-boundary)): there
  a vote the platform's own checks refuse answers `unknown`, not `refused` (`local_authorization_held`), and a failure
  that reaches a caller as `unknown` isn't logged (`unclassified_error`).

**Money path and recovery**
- A send whose provider reply is lost blocks its executor's later sends, with no review procedure yet; nothing is sent
  twice, but the block doesn't clear after settlement or with `pnpm reconcile` ([enforcement](docs/enforcement.md)).
- The held-payment list reads at most 1,000 history entries from the approval day, which may include other agents' on
  the same API key; past that it reports the list incomplete (and changes nothing) instead of listing every held payment.
- A provider `FAILED` status is treated as terminal; it isn't verified to make a replacement payment safe
  ([recovery guidance](DEMO.md#the-live-moment-one-invoice-end-to-end-facilitator)).
- Payment recovery reads and owner-action discovery are offline-tested only. Discovery scans at most 250 provider
  records from the past day (an incomplete scan says so); original terms depend on provider and local retention; owner
  actions are found only on the instance holding their records; the dashboard's repeat-signing guard is not a
  cross-instance lock. Unverified ownership after a cold gateway restart stays denied.
- Prepared-invoice continuation is offline-tested (`test/invoice-http.test.ts`), not on a deployed host; it refuses
  revised or submission-attempted invoices and doesn't resolve unknown outcomes.
- The local duplicate check covers only a manual payout matching a held one, and a payout request may opt out of it
  (`allowDuplicateHeld`, 0.5.5); provider replay deduplication is unverified.
- The auto-execute ceiling compares exact decimal sums; raw-amount conversion, valuations and the plan-preview total
  still use floating point. Provider caps and the USD budget are unaffected.

**Policy and provider**
- Cumulative per-asset caps and the USD budget can't be overrun by this executor's own simultaneous sends (offline-tested); for
  other senders (another host, the grant used directly) they rest on the provider, whose docs call its cumulative
  limits best-effort under concurrency in one place and serialized per wallet in another. One concurrent mainnet trial
  held the budget. A held payout doesn't block later sends, so several can be filed before any settles. Provider
  questions Q1–Q5 in the [enforcement assessment](docs/enforcement.md#spending-limits-under-concurrency).
- The policy's asset list limits what the agent spends, not what it buys: the wallet lets a swap into an unlisted
  asset through. This server refuses one before sending; the wallet should.
- The owner can't verify the enforced policy: it is stored encrypted to the custody keystore, and the public
  `store_wallet_policy` takes no `agent_policy_hash`. The mandate digest is this server's own.
- A refusal says `policy_denied` without naming the rule. Confidential credits from outside the API can't be
  attributed: nothing public indexes `intents.far`.
- Signing requests stay open 5 to 10 minutes, so a slow council misses the window. Trezu shows these proposals as a
  generic "sign on v1.signer"; the dashboard's "What am I voting on?" shows what each does.
- DAO delegate preparations are serialized per owner on one host only (offline-tested); file them one at a time.

**Owners, wallets and payees**
- A wallet-owned agent was created, granted and swapped on its own from a local dashboard on mainnet (2026-10-13,
  [mainnet log](docs/mainnet-log.md)); behind the hosted gateway it is offline-tested only. The dashboard offers the
  wallets HOT's near-connect list declares for delegate signing (today HOT, Meteor, Intear, Ledger and NEAR Mobile);
  Meteor has signed so far.
- The wallet picker loads that list from its `main` branch, unpinned, and each wallet's code from where it points. The
  server checks every owner signature before relaying it, but a changed wallet could phish for keys.
- Agreed terms (an amount per invoice and a deadline) are shown to voters beside each held payout; nothing refuses an
  invoice outside them. A DAO or other contract account can be paid but can't ask to be paid on the invoice page
  (sign-in there needs a full-access key).
- Multi-owner hosted onboarding, scoped payee journeys and self-service hosted creation are offline-tested only:
  hosted creation, grants and payments for arbitrary wallet and DAO owners, Trezu setup, capacity under load and
  invoice intake for new Payables agents aren't observed. The 32-instance cap isn't abuse-resistant admission. Payee
  conversion and forwarding aren't built.
- Work orders have no mainnet lifecycle yet; partial invoices, amendments, automatic residual return and archival
  aren't built; executors run on one host, eight by default. Exact invoice matching and one payment identity are
  local checks, not provider guarantees. See [operations](docs/operations.md#work-order-executors). The live
  owner-to-payee work-order journey and fresh payee sign-in are unverified
  ([bounded journey check](docs/shared-frontend-integration.md#bounded-payables-journey-check--2026-10-16-utc)).
- Campaign winner identity and prize validation aren't built.

**Treasury**
- The autopilot (off by default) hasn't run unattended for days; outside the dashboard its warnings reach the owner
  only through the optional Telegram notices.
- The inline strategy workflow is offline- and browser-fixture-tested only. Stop prevents future ticks, but a tick
  already started can still submit; configuration coordination is single-host.
- Sweep covers managed USDC, wNEAR and ETH only.
- The run-log adapter, export and recording inspector are offline-tested, with no timed playback, live stream or
  real-recording validation
  ([Treasury](docs/treasury.md#run-log-adapter-and-export-offline-tested),
  [progress rollout](docs/operations.md#run-progress-rollout)).

**Infrastructure and walkthroughs**
- The shared-host hardening is local, not deployed ([architecture review](docs/archive/infrastructure-review.md)), and
  the coordinated [credential rotation](docs/credential-rotation.md) after the diagnostic exposure is outstanding.
- FastNear deposit batching awaits a verified raw-transaction hash mapping; deployed indexer freshness is unverified
  ([follow-up](docs/archive/infrastructure-review.md#follow-up-review-2026-10-16)).
- CI doesn't build or check the `platform` image (no Docker in the job): only a release candidate does, as its last
  gate (`pnpm check:platform-image`; [operations](docs/operations.md)).
- Every deploy still uses Railway's Config as Code, which the Railway CLI warned on 2026-11-05 keeps working only until
  2026-12-01; later deploys need Railway's Infrastructure as Code (`.railway/railway.ts`). Not migrated:
  `deploy/railway.gateway.json`, the `platform` package's root `railway.json` (staging and production). See
  [operations](docs/operations.md#railway-config-as-code-ends-2026-12-01).
- Guided walkthroughs and short guides (`/demos`) are tested with offline browser fixtures, not on the deployed hosts,
  and can't guarantee a swap, prompt approval or settlement. Guidance is deterministic, not an LLM; live AG-UI agent
  orchestration isn't built.
