# Mainnet log

Dated mainnet runs: what each showed, with the DAO proposal numbers anyone can read on chain. Each
prototype's doc says which of these back which claim: [facilitator](facilitator.md),
[treasury](treasury.md). Operation ids, amounts, payees and the strategy's settings are kept in a private
release record, not here, since the treasury is confidential; they are available to reviewers on request.

## A swap into an unlisted asset, 2026-10-10

A direct-API swap into an asset outside the policy's `assets` succeeded: the provider checks only the
asset spent. This server now refuses such a swap before sending ([enforcement](enforcement.md#status)).

## First payouts, 2026-10-11

Payouts from a confidential Trezu treasury (`agentic.sputnik-dao.near`). The payout agent was created,
granted and added to the treasury agent's agreement by DAO vote (proposals #23 to #25).

| Check | Result |
|---|---|
| A payout waits for the DAO | A payout to an agreed payee went `PENDING_APPROVAL`, was released by proposal #26 and settled |
| A new payee is refused | The treasury agent's transfer to an unlisted account was refused with `policy_destination_denied` before anything was recorded |
| Over-limit is refused | A transfer by the treasury agent over its hourly cap, under policy revision 8 (owner approval off, so no vote was involved), was refused with 409 `policy_denied`; nothing was sent. It exceeded only that cap; `policy_denied` doesn't name the rule |
| Agents fund each other without a vote | The treasury agent funded the payout agent inside its caps |
| Nothing public but the vote | The payout agent's account has no public transactions, and no public NEAR Intents balances changed (NearBlocks, `mt_tokens_for_owner`) |
| The payee sees no sender | near.com shows the receipt with only a one-time 1Click deposit address, which 1Click's public status lookup doesn't know |

What stays visible or known: each approval is a public DAO proposal, so its timing shows; 1Click and
NEAR Intents can see the mapping, and their terms don't guarantee confidentiality. A held payment
stays approvable for 24 hours, but each vote request expires in about 5 minutes.

## The treasury agent rebalancing itself, 2026-10-12 (UTC)

The strategy (a target allocation, a cost cap at each swap's floor, and a ceiling per hourly run) is
approved only by a grant whose label carries its digest.

| Time | What happened |
|---|---|
| 13:19 | The strategy's ceiling was raised without a new grant: the autopilot planned a swap and sent nothing, asking the owner for a grant with the new label (inbox; no request in the ops log) |
| 13:28–13:55 | The DAO voted grants for the new strategy, one per change of ceiling and cost cap |
| 13:57, 14:06 | The swap passed the strategy and grant checks; the Agent API refused it with `spend_budget_exceeded`, recorded as refusals. Nothing moved |
| 16:17 | After the budget reset, the autopilot executed the swap alone, its plan bound to the strategy digest, bringing the book close to its target |
| 17:20 | Execution moved to the hosted `dao` service on Railway (deployment `c8934842`); the laptop's dashboard is approve-only |
| 20:36 | On Railway, Run now executed a rebalance alone, as two quoted legs, settling the book on its target. A run executes only if its whole plan is within the ceiling and each leg meets a minimum; the run before, over the ceiling, was left for the owner |

Along the way, two new pre-send checks held every agent until fixed: refused requests counted as missing
history, and budgets compared as text, so one amount written two ways differed. Both failed safe: nothing was sent.

## Invoices, 2026-10-12

The invoice page went live on Railway. A contractor signed in with a NEAR wallet as an agreed payee,
submitted an invoice, the DAO approved it from the dashboard (listed as `remote`, from the API's
history), and it was paid; the same flow ran locally first. Earlier test invoices were imported
read-only with their recorded outcomes.

The same flow at the custom domains, with both executors on Railway: an invoice filed at
invoices.multiagency.ai, approved from proto.multiagency.ai and voted in Trezu (proposal #47), was paid.
The invoice before it was held, approved an hour later (#46), and then failed: the payout wallet was
empty, and the API had taken it to `PENDING_APPROVAL` anyway. The treasury agent refilled the wallet
without a vote. Later that evening a held payout was approved by #50 (filed 21:47:10Z, on chain 21:47:16Z) and settled
at 21:48:03Z, per the payout agent's history; the walkthrough's record has it as an invoice.

## One-click approval, 2026-10-12 22:17 UTC

A member who may propose and vote filed the approval and voted on it in one transaction (`add_proposal`
+ `act_proposal`), so proposal #51 executed at once and the server submitted the signature. The payout
itself then failed at the provider, with the reason redacted. The wallet was empty when checked
afterwards, which suggests insufficient funds (the deployment then had no balance check), but that's
unproven.

A failed vote rolls the filing back: reproduced on a local sandbox with mainnet's DAO code, a stale id, a missing id
and too little gas each left no proposal, kept the id counter and refunded the bond.

## Isolated test agent: shield and monthly cap, 2026-10-13T03:27Z

Run with the user's explicit authorization, during the unattended-run window, from base `9b9fe64` plus the
then-staged runner and `update-policy`, on an agent created for these tests by the laptop CLI owner,
never a production treasury or payout agent. Gas and storage ceilings weren't checked by the runner; the
remaining funds stay in the test agent.

One grant, autopilot off. The test policy: a USDC monthly cap smaller than two of the swaps below, wider caps per
transaction, hour and day, and a USD budget well above the test's spend in every window; the destination list copied
byte-for-byte from the treasury agent's revision 11. Funded with a little USDC (confidential) and a little wNEAR
(public). Preflight: the applied policy matched, budget zero in every window, quote worst cost 179 bps.

| Step | Result |
|---|---|
| Shield the public wNEAR under the treasury's destination list | SUCCESS: public → confidential, USD budget unchanged |
| A small USDC → wNEAR swap | SUCCESS; its value charged to the budget |
| The identical swap again | `policy_denied`, no correlation id, balances and budget unchanged. Only the USDC monthly cap was exceeded: every other limit, the budget and the balance fit |

`policy_denied` names no rule and per-asset usage isn't exposed, so the monthly attribution rests on the
isolation and on the first swap being the agent's only USDC spend. Sequential, one grant, one host: it
shows the monthly cap enforced, not its behaviour under concurrency. The runner is archived at commit
`c25b61b` (`src/envelope-phase1.ts`).

## Isolated test agent: USD budget under concurrency, 2026-10-13T03:32Z

Same agent, policy revision 3 (a small daily USD budget, all else unchanged), with room left for about two
more of the swaps below. Five identical small swaps sent at the same instant straight to the API with the
test grant, bypassing this server's money lock (archived runner `scripts/envelope-concurrency.ts`, commit
`c25b61b`).

- One accepted and settled, one `wallet_busy`, three `spend_budget_exceeded`.
- No overshoot: the budget ended under its limit.
- More conservative than the limit suggests: two would have fit, one ran, and requests were refused while
  room remained. Why is unknown.

One trial, five requests, one grant, one host: not proof of atomicity across grants or API instances, or
after a crash.

## Policy signatures and operation proofs, 2026-10-13T04:10Z

A read-only capture from `api.demo.agentsonintents.com`; nothing was generated, signed or submitted.

- All 15 returned policy revisions (treasury 1–11, payout 1, test agent 1–3) reproduce their API
  `policy_hash`. Nine captured NEP-366 policy delegates and nine custody ciphertext-store signatures
  verify, and fail when receiver, arguments or caller are changed. This binds the encrypted blobs, not
  their match with the readable policy. The policy-transaction checks used earlier RPC captures because
  fresh requests timed out; chain inclusion and historical key authority weren't independently checked.
- The ten retained NEP-413 owner signatures (five grant issues, one revocation, four approval votes)
  verify and match their recorded DAO hashes; changed messages and recipients fail. None is a policy
  update, so no owner policy signature has yet been verified against the enforced policy.
- Operation proofs: all three sampled successful operations (a treasury swap, a payout, the test
  agent's swap) returned HTTP 501 `transparency_log_disabled`. That is an unavailable check, not evidence
  of a wrong debit.

The sanitized results, capture manifest, raw captures and one-off scripts are kept in the private release
record.

## A held payout stays in the reported balance, 2026-10-13

The empty payout wallet was credited (15:22:52Z), an invoice payout was held for approval (15:23:23Z),
and the confidential balance read the same at 15:25:03Z: the provider's reported balance still includes
payouts held for approval. The balance check subtracts held payouts itself, so it doesn't count them
twice.

## One-click approvals paid, 2026-10-13

Two invoice payouts, each held for the DAO, approved from the dashboard by a member who files and votes in
one transaction; both proposals read Approved on chain with one vote.

| Proposal | Held | Approval filed → signed | Paid |
|---|---|---|---|
| #53 | 15:23:23Z | 15:26:01Z → 15:26:20Z | 15:26:25Z |
| #54 | 17:07:54Z | 17:10:54Z → 17:11:17Z | 17:11:25Z |

Each payout settled within about 25 seconds of its approval being filed (the payout agent's own history).
The payout before them, approved by #51 on 2026-10-12, had failed with an empty wallet.

## A wallet-owned agent from the dashboard, 2026-10-13T21:26Z

The first agent owned by a person's wallet rather than the DAO: a personal NEAR account, signing in Meteor Wallet
on a local dashboard (`ENV_FILE=.env.wallet`), with the working tree's code, including the
server's check of each wallet signature before it is relayed (`src/owner-signature.ts`).

| Step | Result |
|---|---|
| Create a treasury agent: a NEP-366 delegate action calling `store_wallet_policy` on `outlayer.near`, with a small NEAR deposit attached from the owner | SUCCESS, signed 21:25:52Z; policy revision 1 applied on chain 21:26:03Z |
| Issue its grant: a NEP-413 message, labelled with the strategy digest | SUCCESS, 21:26:25Z to 21:26:27Z |
| Fund it: a small USDC deposit to a one-time deposit address | Credited straight to the confidential balance, in full; nothing public |
| Run now, autopilot off, auto-execute limit zero | 21:28:50Z: "book on target", no plan, no shield, nothing sent |
| Afterwards (`pnpm inspect`) | The default treasury policy as applied: swaps only, no destinations, the default USD budget, none of it spent |
| A second small USDC deposit | Credited confidential |
| The owner raised the auto-execute limit and signed a new grant whose label carries the changed strategy (NEP-413) | SUCCESS, 21:43:08Z |
| Run now, 21:43:45Z | Planned nothing: each leg priced just under the minimum leg size, with USDC quoted slightly below $1 |
| Run now, 21:48:56Z | Stopped at the provider's rate limit for the shared API key ("Too many requests"); no operation record written, nothing sent |
| Run now, 21:50:07Z | Planned two legs, USDC → ETH and USDC → wNEAR, and executed both under the wallet-issued grant, with no owner signature: step 1 sent 21:50:40Z, SUCCESS 21:51:12Z; step 2 sent 21:51:20Z, SUCCESS 21:52:01Z; the tick ended at 21:52:02Z |
| Run now again at 21:51:06Z, during that run | Skipped: "a tick is already running" |

All three wallet signatures passed the server's check and the API accepted them. Two earlier requests,
one per step, were prepared and left unsigned; they expired. The first tick sent nothing: a deposit lands
confidential, so there was nothing to shield, and every leg was under the minimum leg size. So this shows a
wallet owning, granting and running the agent, and its autopilot moving money on its own under the
wallet-issued grant. It ran locally; behind the hosted gateway a wallet-owned agent is offline-tested only.

## The treasury's resting position, 2026-10-13T23:03Z

A read-only check of the treasury agent: no public NEAR Intents balance on chain (`intents.near`
`mt_tokens_for_owner` empty), and the API reports all three of its assets in the confidential balance.
This shows the position private at that moment. It is kept so by this server's requests, not by the policy,
which allows public swaps and unshield ([enforcement](enforcement.md)).

## A sweep on the treasury agent, 2026-10-14 (UTC)

The treasury agent keeps nothing public on its own (its deposits and swaps are confidential), so a public
balance was made on purpose: a one-time public deposit address for USDC from the API (a direct call with
`confidential: false`; the dashboard only asks for confidential ones). A small USDC transfer on NEAR to that
address was credited to the agent's public balance (deposit created 00:33:15Z, settled 00:37:24Z).

The dashboard's Sweep (Automations: the same `sweep` the autopilot runs each tick) shielded it: SUCCESS, 00:39:13Z to
00:39:24Z. At 00:41:38Z the public balance was empty again.

Before the USDC, a native NEAR transfer was sent to the same address by mistake; it hasn't appeared on the agent and
its outcome is unknown. Privacy cost: the sending account is linked on chain to that deposit address.

## A bounty paid, 2026-10-14 (UTC)

The payout wallet was empty, so the treasury agent topped it up first with the dashboard's Top up, its own
send with no vote (00:45:47Z to 00:45:53Z). The DAO offered an award to an agreed payee from the dashboard's
Agreements; the winner signed in on invoices.multiagency.ai and filed under the offer. The payout was held
for approval at 00:47:18Z. A member approved it from the dashboard in one transaction, proposal #56 (on chain
00:50:07Z, Approved, one vote); the approval was signed by 00:50:23Z and the confidential transfer settled at
00:50:32Z.

## A rebalance charges the treasury's budget, 2026-10-14T00:50Z

A Run now on the treasury agent, on dao `0d5964ea` (from `d9cb581`), executed one small USDC → wNEAR leg (settled
00:51:48Z). The run's record shows the daily USD budget left before and after, lower by the swap's value; the
dashboard's Latest run panel shows the same. This is the treasury agent's own budget, not an isolated agent's.

## An agreement request, declined, 2026-10-14 (UTC)

An account the DAO hadn't agreed to pay signed in on invoices.multiagency.ai and asked to be paid (00:55:43Z).
The invoice host recorded it as an agreement request, not a payment: nothing reached the provider (the payout
agent's latest operation is still the bounty's approval at 00:49:58Z). The request showed on the dashboard's
Agreements and was declined there; the store records the decline, not its time. The payee's page then read
"The DAO declined this request." No policy update was filed.

## The payout rehearsal, 2026-10-14T02:02Z

An agreed payee who isn't a DAO member filed an invoice on invoices.multiagency.ai; it was held for approval at
02:02:37Z. A member approved it from the dashboard, filing and voting in one transaction: proposal #57, on chain
02:04:12Z, Approved with one vote. The DAO's signature was submitted at 02:05:10Z and the payout settled at
02:05:14Z, about a minute after the vote.

The flow wasn't as expected on the dashboard (dao `4becd066`). Reading the code afterwards found why the payment
timeline can't follow it to the end there: it lists held payments, and a settled payment sent from the invoice host
isn't in the approve-only copy's activity, so it drops out once paid. The next build keeps a payment in view through
to Paid.

## App access on platform staging, 2026-10-28 (UTC)

The first run of an app's path on mainnet: platform staging at api.dev.multiagency.ai (Railway deployment
`23f3687e`, release candidate `9564c37a`, commit `12cf37b`), driven by the local app stand-in
(`scripts/staging-app.ts`) with a wallet-owned payout agent created for one Organization. The provider host is
api.demo.agentsonintents.com, whose `/v1/network` reported mainnet on 2026-10-13. The amount was small; the
payee was the owner's own second account.

| Check | Result |
|---|---|
| Creation goes to the platform's confirm page | The provider answered the creation as NEP-366; the app received only a confirm link. The page showed the deployment, Organization and the payout policy at creation; the owner signed its opening text and then the action there, and the agent was created |
| A NEP-413 owner action is readable in the wallet | The payout grant's prompt showed its full text (agent, label, expiry, network), the recipient and the requesting page; signed in the app, it applied |
| The first payee is a NEP-413 edit | Adding the first payee came back NEP-413 and was signed in the app, not on the confirm page; it applied (`SUCCESS`) |
| An app funds the agent | A deposit address taken through the app (payout consent) was funded; the payout request then found the balance |
| A payout request waits for the owner | The request was held (`PENDING_APPROVAL`) and read `held` |
| The owner's vote, relayed by the app | The prepared vote carried the payee, asset and amount proven against the provider's request hash, matching the request; the owner signed it in the app; the provider answered `PROCESSING`, then `SUCCESS`, and the request read `succeeded` |
| Nothing public at the payee | The payee holds no public NEAR Intents tokens afterwards (`mt_tokens_for_owner`, block 222032482) |

Not checked: the payee's receipt in near.com; what the wallet displayed for the vote (the recorded format is
`approve:{approval_id}:{wallet_pubkey}:{request_hash}`, with no payee or amount); asking the same request again
(the stack E2E shows it answers without sending). Found on the way and fixed before the payout: the provider's
API #51 (2026-10-27) reports an uncapped budget window's spend as `null`, which the agent's overview refused
([enforcement](enforcement.md#recovery-limitation)).

## A DAO-owned Treasury agent through an app on platform staging, 2026-11-04 (UTC)

The first run of DAO owners through apps on mainnet, user-run. It used:
- **Staging:** platform staging at api.dev.multiagency.ai (Railway deployment `bc635cb7`, release candidate `0263df8e`,
  commit `6ba0831`, SDK 0.5.0).
- **The app:** the local app stand-in (`scripts/staging-app.ts`, deployment `staging`, Organization `org_dao1`).
- **The DAO:** `agentic.sputnik-dao.near`, which passes a proposal with one vote. One member, `multiagentic.near`,
  filed and voted each proposal, through a wallet from the stand-in and through `near-cli-rs` for the stop.

No funds moved.

| Check | Result |
|---|---|
| A DAO sets up a hosted agent by vote | The setup's check page recomputed the hash ("it matches"). Proposal #59, filed and approved in one transaction (~22:19), signed it through `v1.signer`. FastNEAR's transaction API showed the signature, and the platform reserved `own-4f7bfc06…` with a setup consent (`signer: dao`, `unborn`) |
| The agent is created by a second, fast vote | The provider's creation intent named owner `c1bec849…eb45`, the account `v1.signer` derives for the DAO on path `agent-owner`. The vote passed inside the intent's window, and the agent found the signature and submitted it itself: `SUCCESS` 22:28:52 |
| The DAO consents to the app by vote | Proposal #61 (filed 22:30:05) signs exactly the request's hash. The consent was stored at 22:31:22 with `signer: dao`, scopes `read` and `treasury`, and the DAO's derived key |
| The strategy-bound grant by a fast vote | The proposal (#62) named the strategy suffix and terms and said it authorizes swaps without a vote each time. `SUCCESS` at 22:35:24, about 2.5 minutes before the intent expired |
| An app turns autopilot on under the DAO's grant | `autopilot/enable` with the strategy's digest answered `on: true` (22:43:27) |
| The DAO stops its agent with no app | The stop page filed the stop. Its check page matched. Proposal #63 was filed and voted through `near-cli-rs`; `v1.signer` logged the request for `agent-owner` over the stop's hash. Opening the page after the vote applied it at 22:51:32: 2 consents revoked, autopilot off. The app's calls then answered 403 "No live owner consent covers this Organization and agent" |

**Found:**
- **No app route funds the agent.** A DAO's consent (`read`, `treasury`) can't reach `deposit` (it's in the `payout`
  scope) or `treasury/fund`, and no app read returns the agent's wallet account. Funding and a DAO-approved proposal
  (runbook steps 5–6) weren't run.
- **The member's wallet couldn't preview the proposals.** Its simulator doesn't support `v1.signer`'s yield/resume, so
  only the call list showed.

Not checked: Trezu's display of these proposals, freeze and unfreeze by DAO vote, and a proposal's execution.

## A DAO funds its agent and approves a swap through an app on platform staging, 2026-11-05 (UTC)

The second run of DAO owners through apps on mainnet, user-run, on the agent the first run created (`own-4f7bfc06…`),
whose app consents that run's stop had ended. It used:
- **Staging:** platform staging at api.dev.multiagency.ai, SDK 0.5.1. Deployment `f417fc3a` (release candidate
  `2b941c69`, commit `2223d11`) until the fix below, then `3c085b20` (candidate `956a0e55`, commit `8ce51c2`).
- **The app:** the local app stand-in (`scripts/staging-app.ts`, deployment `staging`, Organization `org_dao1`).
- **The DAO:** `agentic.sputnik-dao.near` (one vote passes). Its member `multiagentic.near` filed and voted each
  proposal, through a wallet from the stand-in for the platform's requests and through `near-cli-rs` for the funding.

| Check | Result |
|---|---|
| The DAO consents again by vote | Proposal #64 (03:19:19), filed and voted in one transaction. The consent was stored at 03:19:31 with `signer: dao`, scopes `read` and `treasury`, and the DAO's derived key |
| `account` names the agent's wallet and the grant it holds | First answer on a deployed host (03:19:47): the agent's wallet account, and the grant the first run's proposal #62 issued, matched by token and still in force after that run's stop, as the stop page says |
| An app takes a deposit address under `treasury` | `deposit` answered a one-time address (03:21:22) under the DAO's consent, which has no `payout` |
| The DAO funds its agent by its own vote | The DAO held no USDC on its own account (its Trezu balance is confidential), so the member first sent it a small amount. Proposal #65 then carried the calls `fundingTransaction` builds (register the deposit address on USDC, transfer): approved at about 03:23, it executed with the DAO as sender, and the agent's confidential USDC showed the credit by 03:24:07 |
| An app's proposal, approved by DAO vote and executed | `proposals/create` stored one USDC→wNEAR swap (04:26:47). The DAO's vote request named the swap, its floor and the proposal's hash; its check page recomputed the hash ("it matches"). Proposal #66 (04:29:42) signed it, the platform relayed the approval (04:30:09), and `proposals/execute` sent one swap under the DAO's strategy-bound grant: `SUCCESS` (04:34:52), received above the signed floor, nothing left unresolved, and the provider's USD budget counted the swap |

**Found:**
- **`proposals/create` failed for every proposal at a market price** (03:25:08, `unclassified_error` at `src/mandate.ts`):
  the proposal record was hashed with the policy's canonical form, which refuses non-integer numbers, and a leg's quoted
  USD value is rarely whole. Offline tests priced every asset at exactly 1, so it never showed. Nothing was stored or
  sent. Fixed in `8ce51c2` (records hashed with JCS numbers; whole numbers hash as before), reproduced and tested offline
  (`test/treasury-proposals.test.ts`, `test/mandate.test.ts`), deployed as `3c085b20`; the same request then succeeded.

Not checked: Trezu's display of these proposals, freeze and unfreeze by DAO vote, a DAO's rejection, and a proposal
expiring before its vote. Afterwards the agent keeps its balances under its policy; the DAO's consent from #64 stays
live until 2026-12-05 unless the DAO stops the agent again.

## Token registration reads on the USDC contract, 2026-10-29T14:44Z

Read-only RPC calls (`storage_balance_of` on the USDC contract, final finality), no funds moved. They back the
registration check before a USDC withdrawal ([enforcement](enforcement.md)).

| Account | Answer |
|---|---|
| Existing accounts known to hold or have held USDC | An object (`total` 0.00125 NEAR, `available` 0) |
| An existing account never registered on USDC | `null` |
| An account that doesn't exist on NEAR | `null` |

Not observed: what a confidential withdrawal of USDC to an unregistered account does (whether 1Click registers it, or
how the failure is reported).

## Payout withdrawals on platform staging, 2026-10-30 (UTC)

Withdrawals to a NEAR account through the app path, on mainnet: platform staging at api.dev.multiagency.ai (Railway
deployment `ddbf9361`, release candidate `d1d37e12`, commit `2e620f9`), the same agent as on 2026-10-28, driven by the
local app stand-in. Amounts were small; the withdrawal payee was another of the owner's own accounts, which existed
and was at first not registered on USDC.

| Check | Result |
|---|---|
| Edits to on-chain policy fields go to the confirm page | Agreeing the first withdrawal payee (`actions` gains `withdraw`), adding wNEAR to `assets` with its `limits`, and turning `owner_approval` off and back on each came back NEP-366, reached the app only as a confirm link, and applied (`SUCCESS`, revisions 3 to 6). The first `owner_approval` prepare failed as `unknown` with nothing recorded and succeeded when asked again |
| A wNEAR deposit through the app | It credited the payout agent's confidential balance directly (wNEAR; USDC was seen on 2026-10-28) |
| A wNEAR withdrawal, owner approval off | Sent once and read `succeeded`; the payee's account received the exact amount as native NEAR, with no fee, within about three minutes (account balance, `view_account`) |
| A USDC withdrawal to an account not registered on USDC | Refused `recipient_not_registered` before anything was recorded (`payouts/status` read `not_found`) |
| The same request after the payee registered | Sent once and read `succeeded`; the payee holds the exact amount of USDC, with no fee (`ft_balance_of`) |
| A held withdrawal's approval (read on the host with the provider API) | `request_type` `confidential`; `request_data` has `to`, `chain`, `token`, `amount` and `destination_asset`; its `request_hash` is sha256 of the canonical `{ amount, chain: "near", flow: "withdraw", kind: "confidential", to, token }`. `destination_asset` is not in the hash |
| Approving a held withdrawal | Refused before anything was prepared, as built; the app received `unknown` rather than `refused` (found here; see the README's [Not done yet](../README.md#not-done-yet)) |
| Rejecting it | The provider answered `FAILED` (`rejected`); the payee's balance was unchanged |

Not checked: a confidential withdrawal of an asset whose `destination_asset` differs from its `token`; how a failed
delivery is reported; whether 1Click would have registered an unregistered USDC receiver (the platform refuses before
sending, so it is never tried).

## A wallet owner approves a Treasury rebalance through an app on platform staging, 2026-11-07 (UTC)

On mainnet through platform staging at api.dev.multiagency.ai, running SDK 0.5.3's `platform` package (release
candidate `a434f381`, commit `49b8d51`) as Railway deployment `54fa8a24`, the first deployment with a partner portal
provider key. A wallet-owned Treasury agent, through treasury.dev, with strategy targets USDC 50%, wNEAR 25%, ETH 25%,
autopilot off and a $0 per-run ceiling. Amounts were small; they are in the private release record.

| Check | Result |
|---|---|
| A rebalance proposed in the app and approved by the owner's own signature | At about 05:50Z both swaps (wNEAR → ETH, USDC → ETH) read `SUCCESS` in the app's activity, and the holdings moved to the targets |
| Sends with a partner portal key | Both swaps were sent on `54fa8a24`, whose provider key is from the partner portal |
| The money lock during the run | The gateway logged reconciliation deferred while the swaps held the lock (05:50:16Z to 05:50:37Z), then nothing further |
| A new consent after disconnecting (about 09:26Z) | The owner disconnected and signed a new consent (read, treasury, owner); holdings and books read through the provider, and the strategy grant stayed authorized |

Not checked here: the proposal's ID and the chain transactions (read from the app's activity, not from the provider's
records); a rebalance by autopilot (off, $0 ceiling).


## Market earnings return, local prototype (2026-11-10 UTC)

User-reported mainnet observation from the local `~/agencies/market` prototype, using its own Agent API agent; no
platform gateway deployment was involved. The market refused withdrawal to an unregistered USDC deposit address.
After the owner registered that address and retried, the prototype's deposit status read `SUCCESS` at 02:10:31 UTC.
This records the supplied run transcript, not an independent re-observation in this session and not hosted platform
acceptance. Amounts, deposit and operation identities and transaction hashes remain in the private release record.
The assignment's acceptance text mentioned a marketplace fee, but ledger entries were not supplied, so fee deduction
remains unresolved (market spike S3). No archive, provider restore or hosted-agent release was performed by this run.
