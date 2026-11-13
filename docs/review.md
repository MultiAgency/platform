# Reviewing MultiAgency

An AI agent moves a wallet's or a Sputnik DAO's funds on NEAR Intents mainnet, only inside a policy the owner signed.
The provider (the NEAR Intents Agent API, over OutLayer custody) holds the funds and enforces that policy; this platform
adds owner consent, checks before each send, at-most-once execution with recovery, and verified owner and DAO approvals.

This page is the short version for a reviewer: each claim, how it is known, and where the evidence is. The detailed
records are linked; nothing here is stronger than they are.

## How each claim is known

Every claim carries one of these labels, and no sentence in this repository should claim more than its label:

| Label | Means |
|---|---|
| **offline-tested** | Covered by `pnpm test`, with the provider mocked at its API boundary; crash and concurrency cases use real SQLite and child processes |
| **stack-tested** | Covered by `pnpm test:e2e`: the real application stack against a simulated provider, chain and wallet |
| **mainnet-observed** | Seen on NEAR mainnet, with a date (UTC) and, for a DAO's action, its proposal number in [the mainnet log](mainnet-log.md); op ids, tx hashes and amounts are in the private release record |
| **per provider docs or source** | Read in the provider's documentation or source at a pinned commit; the deployed version is never assumed from its source |
| **unverified** | Not shown |

## Claims

| Claim | How it is known | Evidence |
|---|---|---|
| Every money action is sent from one place, after a write-ahead record, at most once | Offline-tested and stack-tested; the one send site is enforced by a test | [architecture](architecture.md#how-the-money-path-stays-safe-on-one-host), `test/send-path.test.ts` |
| An unknown outcome blocks new sends and never authorizes another | Offline-tested and stack-tested (a lost reply is never resent); no lost reply has happened on mainnet | [recovery limitation](enforcement.md#recovery-limitation), `test/money-safety.test.ts` |
| The provider enforces input assets, actions, destinations, frozen and per-transaction caps | Per provider source and docs; the deployed version isn't established; one destination refusal mainnet-observed | [enforcement status](enforcement.md#status) |
| A payout goes only to a payee the owner agreed | This server refuses a payout's transfer or withdrawal to anyone else before sending (`payee_not_agreed`; offline- and stack-tested); the provider also enforces destinations, per its docs. An invoice leaves the payee to the provider | [enforcement status](enforcement.md#status), `test/authorize.test.ts` |
| A swap can't buy an asset outside the policy | Local check only: the provider lets it through (mainnet-observed 2026-10-10); this server refuses it before sending | [enforcement status](enforcement.md#status) |
| Cumulative per-asset caps and the USD budget hold | This executor's own simultaneous sends offline-tested against a simulated provider that admits racily; one monthly-cap refusal and one concurrent budget trial mainnet-observed (2026-10-13); atomicity across grants, instances or crashes is the provider's and unverified (provider questions Q1, Q2 and Q5) | [spending limits under concurrency](enforcement.md#spending-limits-under-concurrency) |
| A refusal, or "nothing moved", is claimed only on evidence | Offline-tested: a provider failure reaches a client as a typed refusal only on a read, while preparing an owner action (which executes nothing), or under a code proven to execute nothing; otherwise it is `unknown`. A `failed` payout reads `neverExecuted` only when the provider's own status says it never executed and shows no effect (per provider docs; not mainnet-observed) | [errors at the RPC boundary](architecture.md#errors-at-the-rpc-boundary), `test/owner-contract.test.ts`, `test/payout-requests.test.ts` |
| An owner's approval releases exactly the payment shown | The provider's request hash is recomputed from the readable terms before signing; transfer approvals mainnet-observed and paid (2026-10-13); withdrawal approvals offline- and stack-tested, and their hash doesn't cover `destination_asset`. An app may also send the owner to the platform's own confirm page, which shows the agent-proven terms (offline- and browser-tested, not deployed); it doesn't bind a dishonest app, which can simply not send the owner there | `src/payment-approval.ts`, [enforcement status](enforcement.md#status), [app access](app-access.md) |
| A grant ends at the expiry the owner signed | The agent stops using a grant past its expiry (offline-tested); that the provider then refuses its sends is per provider docs, not mainnet-observed. An owner may choose the expiry, up to the provider's 365 days | [app access](app-access.md), `test/grants.test.ts` |
| The final signed artifact carries the approved terms | Not claimed: it rests on an honest coordinator (per provider source) | [enforcement status](enforcement.md#status) |
| The owner signed the policy the provider enforces | Unverified: the enforced policy is stored encrypted, and some policy edits have the owner sign ciphertext | [enforcement status](enforcement.md#status) |
| Apps act only with the owner's consent, through `/apps/v1` | Offline- and stack-tested; on platform staging mainnet-observed for payouts (2026-10-28), withdrawals (2026-10-30), a DAO-owned Treasury agent (2026-11-04, 2026-11-05) and a wallet owner's approved rebalance (2026-11-07) | [app access](app-access.md), [mainnet log](mainnet-log.md) |
| An owner's stop ends every app consent given before it | A DAO's stop mainnet-observed on platform staging (2026-11-04, proposal #63: two consents revoked, autopilot off); a wallet owner's stop offline- and browser-tested, not deployed. After a wallet stop, a consent or setup is stored only if the platform issued its nonce after the stop (offline-tested). The provider grant stands: a stop removes app authority. A wallet owner's stop may also freeze the agent, the owner's wallet signing the provider's freeze intent on the platform's page (0.5.5; offline- and browser-tested with a stand-in wallet, no freeze recorded on mainnet); a DAO's stop doesn't freeze | [app access](app-access.md), [mainnet log](mainnet-log.md) |
| A payee can read their own terms in the policy without trusting an app | Offline-tested, not deployed: under the owner's signed payee disclosure the platform host answers the payee's own entries, caps, approval, frozen and revision from the provider's current policy (and its mandate digest only if the owner opts in); it is the platform's word, not independently checkable | [app access](app-access.md), [enforcement](enforcement.md#a-payees-view-of-their-own-terms-offline-tested) |
| A DAO acts as owner by its own vote, through NEAR's MPC signer | Mainnet-observed; owner intents that expire before a slow vote passes can't complete | [DEMO verification](../DEMO.md#what-is-verified), [mainnet log](mainnet-log.md) |
| The treasury's resting position stays confidential | Enforced by this server (every swap sent confidential, deposits land confidential), not by the policy; unverified on mainnet | [the envelope](enforcement.md#the-envelope) |
| Every plan and money action records the policy it ran under | The mandate digest (sha256 of the policy's canonical JSON) is recorded with each; anyone holding the policy can recompute it. It is this server's own, not the provider's | `src/mandate.ts` |
| The books reconcile | Not independent proof: public balances are compared with chain transfers, confidential ones with the provider's recorded executions; differences are reported as unexplained | `pnpm books` |

## What isn't done

The canonical list is the README's [Not done yet](../README.md#not-done-yet). The gaps a reviewer should weigh first:

- Payables still carries its own copy of the money path, so a fix here doesn't reach it.
- One executor per agent is a single-host lease, not distributed fencing.
- A provider `FAILED` status is treated as terminal; it isn't verified to make a replacement payment safe.
- A second payout of an invoice already paid, under a new `requestId`, reaches the owner's vote as a new payout; only the
  app deriving the `requestId` from its own records, or the owner, stops it ([crash test](crash-test.md)).
- A proposal's approval is the platform's check, not the provider's: whoever holds the treasury grant can swap within
  the policy without it.
- The autopilot hasn't run unattended for days on mainnet.

The tagged 0.5.6 SDK uses provider SDK 0.8.2, with policy evidence compatibility tested for `limit_order` and unchanged
refusal/idempotency behavior. The tagged and published 0.5.7 SDK also lacks order routes. The 0.5.8 Treasury
limit-order feature has local order routes, owner signatures, a dedicated app consent and offline recovery tests. No
live order was placed by this platform. The separate Treasury app
[PR #11](https://github.com/MultiAgency/treasury-prototype/pull/11) records the exact frozen 0.5.8 SDK package
and local consumer tests for credentialed capability discovery, cancellation continuation and retained decisions.
A package built from later SDK source has different provenance and needs a matching app retest. App hosted acceptance,
deployed provider support and live order outcomes remain open.
The [cross-repository HTTP gate](../test/cross-repo/treasury-orders/README.md) exercises both real servers against a
simulated provider and chain; its result names the exact source and package it checked. It is separate from browser
wallet and deployed provider evidence.
Production provider order routes were absent in the 2026-11-10 read-only check.
Consequently, a 0.5.8 platform using that provider would refuse hosted-agent release after its other prechecks,
including for agents with no local orders; a working order-list route or separately reviewed absence proof is a
production rollout gate ([release check](agent-release.md#release)).
Native signing remains out of scope. See [limit orders](limit-orders.md) and
[provider SDK upgrade](provider-sdk-082.md).

## Checking it yourself

- `pnpm verify` runs the whole offline sequence: typecheck, offline tests, browser suites, the narrow E2E run and the
  evidence drift check. CI runs it on Node 24 for every push to `main` and every pull request ([testing](testing.md)).
- `evidence/inventory.ts` is the one requirement and evidence inventory; `pnpm evidence:check` rejects generated
  documents that drifted from it. The area pages present it: [Payables](facilitator.md), [Treasury](treasury.md).
- `pnpm smoke` reads a host without signing in or moving anything.
- Op ids, tx hashes, amounts and payees for every mainnet run are in the private release record, available to reviewers
  on request.


The 0.5.6 [hosted-agent release](agent-release.md) has offline/stack checks of archive/restore relaying,
executor refusal, capacity recovery, consent termination, retained identity, child shutdown, registry crash points and
an older registry reader. External archive/restore behaviour is per pinned provider docs; no platform mainnet release
is recorded. An incomplete transition needs recovery before rollback; DAO release remains unavailable.

Market hires enforce the full approved price against the policy's USDC per-transaction ceiling, including retained key
funds, before funding and again before signing (`test/market-hire.test.ts`, `test/authorize.test.ts`; offline-tested).
The local market stack also covers a listed worker's token-scoped assignment, signed `hire.created` webhook with a
duplicate delivery, polling-only submission, and payment relayed on delivery (`test/e2e/market-worker.spec.mjs`;
offline simulation, not deployed-market or earnings-return evidence).
Cumulative caps and budgets still account for provider withdrawals. Downgrade below 0.5.6 is unsupported after shared
market records exist: the previous reader rejects a market reservation and prevents the whole gateway starting,
including Treasury and Payables (`test/market-rollback.test.ts`). See [market](market.md#rollback) and [operations](operations.md).


DAO-owned app payouts: SDK 0.5.9 candidate admits Payables setup and payout consent, and routes payout
grants and held-payout votes through existing verified DAO owner actions. Contract and gateway
coverage: `test/app-dao.test.ts`. Paperwork adoption and local simulated acceptance are recorded in its
`docs/job-demo.md` and the private local acceptance report. Clean database handoff to another process
is covered; SIGKILL, provider-response-loss and hosted wallet/quorum/mainnet behavior remain unverified.
Not deployed or mainnet-observed. See [app access](app-access.md).

The unreleased 0.5.9 market funding-binding candidate records the caller, request ID, approved terms and payment key
before a top-up. Deterministic funding stages and final destination-receipt checks keep an unproved or still-owned
credit reserved to its hire (`test/market-binding-journal.test.ts`, `test/market-funding-proof.test.ts`; the earlier
`ae60790` market candidate passed the full offline suite, browser checks and narrow stack E2E on 2026-11-11). The public journal-history export reports version 3 binding and landing
metadata as `market_metadata_not_exported` gaps, without exposing its private payload or treating it as payment
evidence (`test/journal-history.test.ts`, offline-tested). The combined Treasury-order reader also omits order
placement/cancellation preparations as `method_not_exported` and isolated final-payout markers as
`cancel_final_not_exported`; the unchanged public schema receives no private order terms or fabricated settlement.
The frozen 0.5.6/0.5.7 and signed 0.5.8 readers reject the first version 3 journal line
(`test/market-binding-rollback.test.ts`). Pin the exact reviewed source and package provenance. Submitted 0.5.6 through
0.5.8 top-ups cannot be retroactively bound and block new hires on
their old key. No supported fresh-key recovery or automatic clearance exists yet; hashless or unavailable receipt
evidence also needs reviewed recovery. This candidate is not ready for a market-agent rollout. See
[market](market.md#rollback) and [operations](operations.md).
