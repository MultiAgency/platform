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
| A swap can't buy an asset outside the policy | Local check only: the provider lets it through (mainnet-observed 2026-10-10); this server refuses it before sending | [enforcement status](enforcement.md#status) |
| Cumulative per-asset caps and the USD budget hold | This executor's own simultaneous sends offline-tested against a simulated provider that admits racily; one monthly-cap refusal and one concurrent budget trial mainnet-observed (2026-10-13); atomicity across grants, instances or crashes is the provider's and unverified (provider questions Q1–Q5) | [spending limits under concurrency](enforcement.md#spending-limits-under-concurrency) |
| An owner's approval releases exactly the payment shown | The provider's request hash is recomputed from the readable terms before signing; transfer approvals mainnet-observed and paid (2026-10-13); withdrawal approvals offline- and stack-tested, and their hash doesn't cover `destination_asset` | `src/payment-approval.ts`, [enforcement status](enforcement.md#status) |
| The final signed artifact carries the approved terms | Not claimed: it rests on an honest coordinator (per provider source) | [enforcement status](enforcement.md#status) |
| The owner signed the policy the provider enforces | Unverified: the enforced policy is stored encrypted, and some policy edits have the owner sign ciphertext | [enforcement status](enforcement.md#status) |
| Apps act only with the owner's consent, through `/apps/v1` | Offline- and stack-tested; on platform staging mainnet-observed for payouts (2026-10-28), withdrawals (2026-10-30), a DAO-owned Treasury agent (2026-11-04, 2026-11-05) and a wallet owner's approved rebalance (2026-11-07) | [app access](app-access.md), [mainnet log](mainnet-log.md) |
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
- A proposal's approval is the platform's check, not the provider's: whoever holds the treasury grant can swap within
  the policy without it.
- The autopilot hasn't run unattended for days on mainnet.

## Checking it yourself

- `pnpm verify` runs the whole offline sequence: typecheck, offline tests, browser suites, the narrow E2E run and the
  evidence drift check. CI runs it on Node 24 for every push to `main` and every pull request ([testing](testing.md)).
- `evidence/inventory.ts` is the one requirement and evidence inventory; `pnpm evidence:check` rejects generated
  documents that drifted from it. The area pages present it: [Payables](facilitator.md), [Treasury](treasury.md).
- `pnpm smoke` reads a host without signing in or moving anything.
- Op ids, tx hashes, amounts and payees for every mainnet run are in the private release record, available to reviewers
  on request.
