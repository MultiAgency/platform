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
unproven. A failed vote rolls the filing back: reproduced on a local sandbox with mainnet's DAO code, a
stale id, a missing id and too little gas each left no proposal, kept the id counter and refunded the
bond.

## A held payout stays in the reported balance, 2026-10-13

The empty payout wallet was credited (15:22:52Z), an invoice payout was held for approval (15:23:23Z),
and the confidential balance read the same at 15:25:03Z: the provider's reported balance still includes
payouts held for approval. The balance check subtracts held payouts itself, so it doesn't count them
twice.

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

## Isolated test agent: shield and monthly cap, 2026-10-13T03:27Z

Run with the user's explicit authorization, during the unattended-run window, from base `9b9fe64` plus the
then-staged runner and `update-policy`, on an agent created for these tests by the laptop CLI owner,
never a production treasury or payout agent. Gas and storage ceilings weren't checked by the runner; the
remaining funds stay in the test agent. One grant, autopilot off. The test policy: a USDC monthly cap
smaller than two of the swaps below, wider caps per transaction, hour and day, and a USD budget well above
the test's spend in every window; the destination list copied byte-for-byte from the treasury agent's
revision 11. Funded with a little USDC (confidential) and a little wNEAR (public).
Preflight: the applied policy matched, budget zero in every window, quote worst cost 179 bps.

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

## One-click approvals paid, 2026-10-13

Two invoice payouts, each held for the DAO, approved from the dashboard by a member who files and votes in
one transaction; both proposals read Approved on chain with one vote.

| Proposal | Held | Approval filed → signed | Paid |
|---|---|---|---|
| #53 | 15:23:23Z | 15:26:01Z → 15:26:20Z | 15:26:25Z |
| #54 | 17:07:54Z | 17:10:54Z → 17:11:17Z | 17:11:25Z |

Each payout settled within about 25 seconds of its approval being filed (the payout agent's own history).
The payout before them, approved by #51 on 2026-10-12, had failed with an empty wallet.

## The treasury's resting position, 2026-10-13T23:03Z

A read-only check of the treasury agent: no public NEAR Intents balance on chain (`intents.near`
`mt_tokens_for_owner` empty), and the API reports all three of its assets in the confidential balance.
This shows the position private at that moment. It is kept so by this server's requests, not by the policy,
which allows public swaps and unshield ([enforcement](enforcement.md)).

## A sweep on the treasury agent, 2026-10-14 (UTC)

The treasury agent keeps nothing public on its own (its deposits and swaps are confidential), so a public
balance was made on purpose: a one-time public deposit address for USDC from the API (a direct call with
`confidential: false`; the dashboard only asks for confidential ones). A small USDC transfer on NEAR to that
address was credited to the agent's public balance (deposit created 00:33:15Z, settled 00:37:24Z). The
dashboard's Sweep (Automations: the same `sweep` the autopilot runs each tick) shielded it: SUCCESS, 00:39:13Z
to 00:39:24Z. At 00:41:38Z the public balance was empty again. Before the USDC, a native NEAR transfer was sent
to the same address by mistake; it hasn't appeared on the agent and its outcome is unknown. Privacy cost: the
sending account is linked on chain to that deposit address.

## A bounty paid, 2026-10-14 (UTC)

The payout wallet was empty, so the treasury agent topped it up first with the dashboard's Top up, its own
send with no vote (00:45:47Z to 00:45:53Z). The DAO offered an award to an agreed payee from the dashboard's
Agreements; the winner signed in on invoices.multiagency.ai and filed under the offer. The payout was held
for approval at 00:47:18Z. A member approved it from the dashboard in one transaction, proposal #56 (on chain
00:50:07Z, Approved, one vote); the approval was signed by 00:50:23Z and the confidential transfer settled at
00:50:32Z.

## An agreement request, declined, 2026-10-14 (UTC)

An account the DAO hadn't agreed to pay signed in on invoices.multiagency.ai and asked to be paid (00:55:43Z).
The invoice host recorded it as an agreement request, not a payment: nothing reached the provider (the payout
agent's latest operation is still the bounty's approval at 00:49:58Z). The request showed on the dashboard's
Agreements and was declined there; the store records the decline, not its time. The payee's page then read
"The DAO declined this request." No policy update was filed.

## A rebalance charges the treasury's budget, 2026-10-14T00:50Z

A Run now on the treasury agent, on dao `0d5964ea` (from `d9cb581`), executed one small USDC → wNEAR leg (settled
00:51:48Z). The run's record shows the daily USD budget left before and after, lower by the swap's value; the
dashboard's Latest run panel shows the same. This is the treasury agent's own budget, not an isolated agent's.

## The payout rehearsal, 2026-10-14T02:02Z

An agreed payee who isn't a DAO member filed an invoice on invoices.multiagency.ai; it was held for approval at
02:02:37Z. A member approved it from the dashboard, filing and voting in one transaction: proposal #57, on chain
02:04:12Z, Approved with one vote. The DAO's signature was submitted at 02:05:10Z and the payout settled at
02:05:14Z, about a minute after the vote. The flow wasn't as expected on the dashboard (dao `4becd066`).
Reading the code afterwards found why the payment timeline can't follow it to the end there: it lists held
payments, and a settled payment sent from the invoice host isn't in the approve-only copy's activity, so it drops
out once paid. The next build keeps a payment in view through to Paid.

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
| Approving a held withdrawal | Refused before anything was prepared, as built; the app received `unknown` rather than `refused` (found here; [Not done yet](../README.md#not-done-yet)) |
| Rejecting it | The provider answered `FAILED` (`rejected`); the payee's balance was unchanged |

Not checked: a confidential withdrawal of an asset whose `destination_asset` differs from its `token`; how a failed
delivery is reported; whether 1Click would have registered an unregistered USDC receiver (the platform refuses before
sending, so it is never tried).

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
