# Demo walkthrough

A DAO, `agentic.sputnik-dao.near`, owns two agents that run its treasury on mainnet. The treasury agent keeps the
treasury at its target allocation, and the payout agent pays the DAO's payees. The treasury is confidential:
anyone can see how the DAO governs its agents, but only members see the money.

The hosted walkthrough below ran until 2026-11-08, when its services were deleted; its hosts no longer answer. The
steps record how it ran. The verification section is generated from the evidence inventory and stays as observed.

| What | Where |
|---|---|
| Signed-in owner walkthroughs | https://proto.multiagency.ai (retired 2026-11-08) |
| Separate invoice demo for payees | https://invoices.multiagency.ai (retired 2026-11-08) |
| The DAO on chain | https://nearblocks.io/address/agentic.sputnik-dao.near |

Keep confidential details out of the talk: no targets, limits, payees or amounts. In the prepared
walkthrough deployment, the public entry explains that the guides use real funds and offers sign-in.
It shows no private records or public walkthroughs. Requirement evidence stays in the area docs.

## What is verified

<!-- BEGIN GENERATED: verification -->
<!-- Generated from evidence/inventory.ts. Run pnpm evidence:write; do not edit here. -->

The table was checked on the 2026-10-12 build: dao `aa6ec064` and invoices `a3aa194a`, from commit `fe3330c`.
The current deployment is dao `4becd066` (2026-10-14 01:32Z), from a clean export of commit `5cd6cc9` per the
deployer (Railway records no commit), and invoices `fcdc06a6` (2026-10-13 22:46:57Z), from `9b2941a`: `d9cb581` and
`5cd6cc9` changed only dashboard pages and docs. Its bundle carries `5cd6cc9`'s card text. After the deploy
`pnpm smoke` passed against both hosts, signed out and signed in as the operator, Automations showed the "Latest
run" panel, and `pnpm demo-check` passed (02:00Z). Before it, dao `708557e6` (01:23Z) served the same pages but the
earlier card text: smoke passed signed out and signed in as the operator, and Automations showed the "Latest run"
panel with the treasury's 00:50Z run, with Steward out of the treasury menu. Earlier still, dao `0d5964ea` (00:43Z,
from `d9cb581`), whose text checks on the card bundle these rows refer to. Of the table, the first, second and fourth rows
have been re-checked on it, and the signed-in operator reads. Before it: dao `2d08148b` (2026-10-13 22:48:02Z, from `9b2941a`), after which the operator
signed in and opened both agents under the per-agent owner check; and earlier dao `cd3115ee` and invoices `1be6e29c`
(18:31–18:32Z, from `37cbba2`). Operation ids and amounts for the rows below are in the private release record.

| Claim | How it is known | When |
|---|---|---|
| Both hosts healthy; signed-out callers refused every agent read; cross-site writes refused | `pnpm smoke`, live, read-only | 2026-10-12 22:13Z; re-checked on dao `0d5964ea` / invoices `fcdc06a6`, 2026-10-14 00:48Z |
| One executor per agent | Railway: one live deployment each, older ones removed | 2026-10-12 22:13Z; re-checked 2026-10-14 00:48Z |
| State survives a restart and a redeploy | Signed-in smoke snapshot before and after | 2026-10-12 20:50–21:37Z |
| Autopilot runs on schedule on that build | First tick's evidence: scheduled, build digests match | 2026-10-12 21:37Z; re-checked on dao `0d5964ea`: the first scheduled tick, 2026-10-14 00:46:01Z, records that deployment |
| Invoice → DAO approval → payment, paid | Submitted at 21:46Z, inferred, by the deployed `invoices` service; approval prepared on an unidentified host, not this laptop's stores; proposal 50 filed and voted in two transactions; executed by the provider: SUCCESS | 2026-10-12 21:48Z |
| Same flow, provider reported FAILED; nonpayment not independently verified | Submitted at 22:16Z, inferred, by the deployed `invoices` service; approval prepared and signed by the user's local approve-only server running the one-click code, uncommitted at the time (proposal 51); executed by the provider: FAILED, reason redacted (an empty wallet afterwards suggests insufficient funds, unproven) | 2026-10-12 22:17Z |
| Signed-in views (member, operator, payee) | Signed-in `pnpm smoke` as the operator passed on dao `0d5964ea`: both agents open under the per-agent owner check, and the DAO's proposals read. The member and payee views, and the pages themselves, not re-checked | 2026-10-14 |
| Typecheck, offline tests, web build | Local; tests use mocks, not the provider or chain | per release |
| Every policy revision reproduces its hash, and the owner's grant and approval signatures verify | [Policy signatures and operation proofs](docs/mainnet-log.md#policy-signatures-and-operation-proofs-2026-10-13t0410z) | 2026-10-13T04:10Z |
| A person's wallet owns, grants and runs an agent; its autopilot swapped under the wallet's grant | [Wallet-owned agent](docs/mainnet-log.md#a-wallet-owned-agent-from-the-dashboard-2026-10-13t2126z); run locally, not through the hosted gateway | 2026-10-13T21:26Z |
| DAO ownership: creation, grant, policy changes, freeze and held-payout approvals | Tested on mainnet with `agentic.sputnik-dao.near`: creating an agent, issuing a grant, changing its policy and freezing it, each by DAO vote (proposals #9 to #12). The freeze was filed from the dashboard through Trezu. Later, policy edits and the approvals of two held payouts were filed and voted the same way from the dashboard; both payouts settled (approvals #17 and #21, edits #20 and #22). | Historical README observation; UTC date and deployment were not recorded in that summary |
| Through app access, a DAO sets up and creates a hosted Treasury agent, consents to an app, issues its strategy-bound grant and stops the agent, each by its own vote | [DAO through an app on staging](docs/mainnet-log.md#a-dao-owned-treasury-agent-through-an-app-on-platform-staging-2026-11-04-utc): `agentic.sputnik-dao.near`, proposals #59, #61, #62 and #63 plus the creation vote, platform staging deployment `bc635cb7`; funding and a DAO-approved proposal followed on 2026-11-05 (next row) | 2026-11-04T22:19Z to 22:51Z |
| Through app access, a DAO funds its hosted Treasury agent and approves an app's swap proposal by its own votes; the app executes it | [DAO funds and approves on staging](docs/mainnet-log.md#a-dao-funds-its-agent-and-approves-a-swap-through-an-app-on-platform-staging-2026-11-05-utc): `agentic.sputnik-dao.near`, proposals #64 (consent), #65 (funding, built by `fundingTransaction`) and #66 (approval), platform staging deployments `f417fc3a` and `3c085b20`; one swap `SUCCESS` above its signed floor | 2026-11-05T03:19Z to 04:35Z |

<!-- END GENERATED: verification -->

Offline tests prove the code's own logic against mocked providers. They don't prove what the Agent API, OutLayer or
the DAO contract do; only a live check does.

## Local layout changes awaiting deployment

The prepared deployment configuration starts with sign-in and then **Your guided walkthroughs**.
It removes public read-only walkthroughs and requirement cards. Legacy example links also use the
sign-in entry. These navigation and self-service changes have not been observed on a deployed host;
the deployment observations above remain historical.

To create an agent, sign in with a regular NEAR wallet. Choose **Create your own agent**, its owner
(**My NEAR wallet** or **DAO through Trezu**) and walkthrough (**Portfolio** or **Payables**).
For a DAO, connect Trezu as the desired DAO while signed in as a member permitted to propose owner
actions. **Continue setup** reserves the instance; it does not create an agent at the provider or
move funds. Review the selected owner, fund the DAO’s owner account if required, and explicitly
sign or propose agent creation. Policy application, grant authorization and funding are checked
separately. Retrying opens the same reserved instance, including after restart.

## Guided walkthroughs in the workspace

This is locally prepared behavior, checked with offline browser fixtures, not a deployed-host observation.
In this build each agent's balances, policy and grants, agreements, payments, strategy, runs and Activity are in its
app (Payables or Treasury). The platform keeps sign-in, setup, agent access, the walkthroughs, the Payables rehearsal and
evidence. A saved link to a moved platform page opens the same path, query and hash in the agent's app.

1. Under **Your agents**, choose the agent’s **Walkthroughs** link, or **Open in Payables** / **Open in Treasury** for
   its app. The agent page links to each short guide and complete walkthrough and shows the area's requirements and
   evidence. Opening a page submits nothing.
2. For Treasury, the walkthrough's chapters open the strategy, the guided run's preview and owner actions in Treasury;
   preview and execution happen there.
3. For Payables, the short guide checks the actual agent, owner, balances and prerequisite observations. For the
   existing approve-only Payables agent, submit an invoice through its configured invoice page as the payee. New
   self-service Payables agents have no configured payee invoice intake; an account with execution permission on a
   payout executor can review and submit a manual payment from the guide. A returned payment appears inline.
4. The guide follows the returned payment only. Approval and settlement are separate; a refusal or unresolved
   operation remains visible, and reloading does not resume or repeat a send. Earlier payments, owner approval and
   recovery open in Payables.

The guide uses the same authorization and submission paths as ordinary work. Its prerequisite observations
are advisory and cannot promise that a later send will be authorized or that a demonstration will settle.

## Separate invoice demo

The invoice demo has its own entry at https://invoices.multiagency.ai and its own payee sign-in.
The local page labels it as a real-funds mainnet demo; that label awaits deployment.

1. The payee opens the invoice demo directly and signs in with the account to receive payment.
2. If no agreement exists, request one. The owner reviews the request and policy in the signed-in
   Payables walkthrough. An agreement request does not submit a payment.
3. Once agreed, the payee files the invoice with its actual terms.
4. The owner reviews the recorded held payout in Payables and explicitly approves it.
5. The payee follows the same invoice until its recorded outcome is known. Approval alone is not
   settlement; an unknown outcome must be reconciled rather than replaced with another invoice.

The existing invoice service remains the payout executor, and the existing payout instance on
proto remains approve-only. This is a separate payee experience, not a second executor or a
sandbox. Newly created self-service agents have no invoice intake attached to this demo.

## Following a task during a read failure

These steps describe local offline-tested behavior, not a deployed-host observation:

1. Open a saved payment, Activity or run URL. If setup or overview is unavailable, the page retains
   its own read-only recovery view and identifies failed observations. Available records do not
   establish a fresh provider outcome.
2. On Strategy, an account with execution or settings permission can stop scheduling while provider reads fail,
   once the private instance read confirms an executor. Accounts without either permission and approve-only instances remain refused.
3. After preparing an owner action, use **Follow owner action** to open its durable Activity record.
   Leaving the initiating page stops its observation loop; server recovery continues. Return to the
   same record after reload. Owner approval and payment settlement remain separate outcomes.
4. On Home, an unavailable agreement or inbox read leaves known attention items and independently
   available status visible. Treat the explicitly incomplete queue as incomplete.

## Before the demo

1. Check the demo's preconditions. It reads only, through the hosted gateway, with a signed-in session
   saved to a file (as for `pnpm run-report`):
   ```
   DASHBOARD_URL=https://proto.multiagency.ai REPORT_COOKIE_FILE=<file> pnpm demo-check
   ```
   It prints `ok` or `FIX` for: the payout wallet's USDC, payments already waiting, the treasury's daily budget
   left (with its reset time), the autopilot's next tick, and the book's drift. It exits nonzero on any `FIX`.
   An empty payout wallet is fixed from the payout agent's Payments page: expand **Funding and budget details**, then **Top up from the treasury** (requires execution permission on the treasury agent).
2. Check both services from outside. It changes nothing:
   ```
   DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke
   ```
3. Sign in once to confirm the session works and the treasury agent's card shows Active, with autopilot on.
4. If you'll pay an invoice live, check that the payout agent's confidential USDC balance covers it. An unfunded
   invoice is refused before it reaches a vote (see [Balance check](#balance-check)).
5. Have a payee account ready in a wallet if you'll submit an invoice live.

## Who sees what

| Persona | Gets in by | Sees | Can do |
|---|---|---|---|
| Visitor (signed out) | — | Real-funds walkthrough introduction and sign-in | Sign in; open the separate invoice demo as a payee |
| DAO member | Being named in an owner DAO's group | That DAO's agents: books, policy, autopilot, held payments | Requests, votes, execution and settings follow the account's applicable DAO permissions |
| Wallet owner | Owning the agent from the connected account | Their own agents | Sign owner actions and use execution/settings controls within the signed policy and grant |
| Payee | Signing in on the invoice page with an account the DAO agreed to pay | Their own invoices and their status | Submit invoices |

The locally prepared access mapping has no operator list. Request-only and vote-only DAO members
cannot trigger direct execution; governance-only members can edit settings but cannot enable scheduling.
See [dashboard access](docs/architecture.md#dashboard-access-offline-tested). This mapping has not been deployed.

## The two areas, outcome by outcome

Each row is one outcome from the area's brief: what to do, what you'll see, and what it leaves as
evidence. What has been shown so far, and where this build differs from each brief, is in the area's doc:
[facilitator](docs/facilitator.md), [treasury](docs/treasury.md).

### Confidential Treasury Facilitator

| Outcome | Do | See | Leaves |
|---|---|---|---|
| Request → vote → paid confidentially | On the invoice page, an agreed payee submits; on the payout agent's Payments page, open Review payment; approve; vote | The invoice moves from waiting to paid; the payee sees no member account | The approval's proposal # |
| A new payee is routed to a new agreement | Sign in on the invoice page with an account the DAO hasn't agreed to pay, and submit | The page says it waits for the DAO; the request appears on **Agreements** | The request, then the policy update's proposal # once agreed |
| Over-limit is refused | Submit an invoice over the per-payment cap | Expected: refused before anything is voted on (not yet shown on this agent) | A refusal with its code, and no proposal |
| Chain watchers can't rebuild the payouts | Open the DAO's proposals on a block explorer or in Trezu | Approvals read "Approve the pending confidential request": no payee, no amount | The proposal #s |

### Agentic Treasury Management

| Outcome | Do | See | Leaves |
|---|---|---|---|
| Balances in, quoted plan out, swaps inside the caps | Strategy → Preview, then open the run view and choose Run now | Each leg quoted and within the cost cap; the budget figure drops by the swaps' value | Each swap in Activity, with the policy revision it ran under |
| A breach is refused | A run whose value exceeds the budget left | Activity shows the over-budget operation refused with `spend_budget_exceeded`; earlier shields or swaps may have completed | A refusal with its code, alongside earlier operation outcomes |
| Idle funds go confidential | When the agent holds a public balance, let the autopilot run | "Held privately" returns to 100% | The shield in Activity |

Record what a run leaves in [docs/mainnet-log.md](docs/mainnet-log.md), reference it in the
[canonical inventory](evidence/inventory.ts), then run `pnpm evidence:write`. The area tables and
app cards use that inventory; do not update their requirement statuses separately.

## The two stories

One scripted run per area, run live from start to finish. The waits are part of the experience: each step
says what's happening and roughly how long it takes. Run `pnpm demo-check` first, and show the configuration as
signed: don't retune the strategy or limits for a demo.

### Agentic Treasury Management: the AI proposes, the autopilot corrects

1. **Steward** (an experiment, not in the menu: open `/a/treasury/steward`): ask it to propose a small swap of USDC into wNEAR. The
   model's plan appears in a few seconds.
2. **Execute plan.** Every step goes through the same checks and policy as any other send. The swap settles in
   about a minute: Portfolio's Allocation now drifts from the target, and the budget figure drops.
3. Open the run view from **Strategy**, then choose **Run now**. The autopilot reads the book, plans the correction
   and quotes each leg. **Follow this run** shows its recorded observations and receipt when the end is recorded:
   the book before, the quoted plan, operation results, and the budget and book after. Check **Activity** for
   subsequent operation outcomes; a recorded run end alone does not prove settlement.
4. **Activity** lists the steward's swap and the autopilot's correction, each with the policy revision it ran
   under.
5. **The refusal.** When the daily budget is nearly used (`demo-check` and Portfolio show what's left), ask the
   Steward for one more swap larger than what remains, and execute it. The provider refuses it, Activity shows
   "refused · over the USD budget". That swap is refused; an earlier shield or swap may already have completed.
   The provider refuses an operation over the budget the DAO signed, whoever asks. A run is not atomic.

Both swaps spend the daily USD budget, so rehearse after it resets (`demo-check` prints when) and leave room for
the live run. Run on mainnet on 2026-10-13, per the operator's record: the steward's swap at 17:55Z, before the
18:31Z deployment, and the autopilot's correction at 18:39Z, on dao `cd3115ee`.

### Confidential Treasury Facilitator: a request, a vote, a confidential payment

1. **The payee asks.** On https://invoices.multiagency.ai, sign in as a payee account the DAO agreed to pay (not a
   DAO member, so the payee never touches the DAO side) and submit a small invoice. In a few seconds the page
   shows it waiting for approval, and says nothing is paid until then.
2. **The DAO hears about it.** The executor's Telegram alert arrives within about a minute; its link opens the
   payout agent's Payments page, where **Payments** lists the payment. Open **Review payment** to see its timeline beside the payee's agreed
   terms (a payee agreed before terms existed shows none on record).
3. **A member approves, in the timeline.** In the locally prepared UI, **File proposal and vote** lets a member who may propose and vote
   file and vote in one wallet confirmation; **File approval proposal** is shown otherwise. The proposal number and its hash appear beside it, with the signing
   window counting down (about five minutes, so approve only when ready to finish); "What am I voting on?" on the
   DAO home shows the same proposal with its hash verified.
4. **It's paid, in the same place.** The DAO's signature is picked up and the payment released and settled, about
   a minute after the vote on 2026-10-14 (proposal #57). The locally prepared timeline labels provider-reported completion **Paid**; the invoice page
   shows **Paid**, and the payout agent's Activity lists it, naming the payee.

A new payee adds one step at the start: their first submission is an agreement request, which the DAO agrees on
**Agreements** (see [the live moment](#the-live-moment-one-invoice-end-to-end-facilitator)).

**Short on time?** File the invoice, or run the steward's swap, just before presenting, and start from the next
step: an invoice stays approvable for 24 hours.

### Paying a list at once: Trezu, not this agent

The payout agent pays one invoice per vote. For a list (a round of awards, a payroll), Trezu, the DAO's
treasury app, offers a confidential bulk payment. One vote pays up to 25 recipients in one token. The chain
shows the proposal, the votes and one hash per recipient, but not who or how much. It pays from the DAO's own
treasury, not through the payout agent, so none of this site's checks or records apply to it. This is per
Trezu's source (near-devhub/trezu at `c1ecee0`), and it hasn't yet been run on this DAO.

Before: the DAO has passed Trezu's one-time "Start activation" proposal for confidential bulk payments, and
Trezu shows a bulk-payment credit available. Each batch attaches a small NEAR deposit when it starts.

1. In Trezu, **Payments → Bulk Payments**: a member with the Requestor role enters the list, or uploads it as
   a CSV, in one token.
2. The proposal reads "Confidential proposal. Details are hidden for privacy." Open it on a block explorer:
   its description carries only payload hashes.
3. Vote in Trezu. The vote must go through Trezu's relay; a vote cast elsewhere leaves the batch awaiting
   approval. Trezu then has each payment signed and sent.

Record the proposal number in [docs/mainnet-log.md](docs/mainnet-log.md), then reference it in the
[inventory](evidence/inventory.ts) beside "A winners list is paid in one auditable batch" and run
`pnpm evidence:write`. A Trezu batch does not establish that capability for this agent.

### A recorded fallback

Record each story once when it runs cleanly, for short pitches and for when mainnet is slow. The live site is for
people who want to sign in and look for themselves.

## 1. As a visitor: what a confidential treasury shows

1. Open https://proto.multiagency.ai without signing in. Each card lists its brief's capabilities and guarantees;
   each guarantee names who stops a misbehaving agent, and each row says whether it was observed on mainnet,
   tested offline, or not yet. Open **Requirements and stages** to inspect the running brief; roadmap briefs stay in the planning docs. Nothing else: no
   balances, payments, roster or proposals.
2. For what anyone can see on chain, open the DAO on a block explorer: each approval reads "Approve the pending
   confidential request", with no payee or amount. The council's roster is public there, as it is for any Sputnik
   DAO; this site doesn't advertise it.

## 2. As a payee: asking to be paid (Facilitator)

1. Open https://invoices.multiagency.ai and sign in with NEAR. It signs a message, not a transaction. Any account
   can sign in; the page never shows the DAO's members or its other payees.
2. Enter an amount and an optional note, and submit. An agreed payee files an invoice, which waits for the owner's
   approval. An account the DAO hasn't agreed to pay files an **agreement request** instead: nothing is paid, and
   the page says it waits for the DAO.
3. Once the DAO agrees, the request shows "Agreed" with **File this invoice**. An offer from the DAO (a purchase
   order or an award) shows its terms with **Use these terms**.

## 3. As a member: governing the agents

1. On https://proto.multiagency.ai choose **Sign in with NEAR**. Access comes from the DAO's own policy: an account
   outside its roles is refused, and one the DAO removes loses access within a minute.
2. **What am I voting on?** lists each proposal asking the DAO to sign as the agents' owner. For an open one, the
   dashboard recomputes the hash from the action an agent prepared, so you see the action in words and that the hash
   really is that action. A hash nothing here prepared is flagged. The vote itself happens in Trezu.
3. Open the treasury agent (**Portfolio**). Its content navigation has Overview and Strategy.
   In walkthrough mode, follow the guide’s prerequisite links to Balances & funding or Policy & grants. The broader workspace retains these as area utilities.
   Activity is shared:
   - **Overview**: attention items, the latest recorded run and a link to its full history, then the book
     against its target and the budget figure: whichever USD budget window (day, week or
     month) has least left, since that one refuses first, labelled by its period ("Daily budget left").
   - **Steward** (experimental, at `/a/treasury/steward`, not in the menu): a model proposes a plan inside the policy; nothing moves until it is executed.
   - **Balances & funding**: reported public and confidential balances and separate held payout
     records, followed by **Receive funds**, expandable **Shield public funds** and **Send funds**. Returns to the linked account sit
     with outgoing payments. **Available to spend** remains **Not established**: these independent
     reads do not prove a spendable amount. Failed held-payout reads do not imply zero, and failed
     linked-account reads do not imply an unlinked account. Payables' `test/browser/funding.cjs` checks these
     states offline, including mobile layout; this is not a deployed observation.
   - **Policy & grants**: the mandate the DAO approved, with a digest anyone can recompute from the policy, and the agent's grants.
   - **Strategy**: the locally implemented strategy editor saves with the schedule off, then opens
     owner authorization with the saved strategy summary. Signing and schedule enablement each
     require an explicit action. This workflow is offline-tested, not yet verified
     on the hosted deployment. **Preview a rebalance** expands the manual preview; the run view remains available. Scheduled actions
     require a grant matching the strategy the owner approved. Manual previews show estimated and
     minimum received amounts, with costs in percent. Each run opens on its recorded outcome and
     operation results; **Run details** contains technical observations and **Inspect recording**.
   - **Activity**: all operations and owner actions returned by each instance, including refusals, assets,
     outcomes and policy revisions. Treasury run history expands into links to individual run details;
     missing-end and unreadable-record warnings remain visible. Full references and policy digests are
     expandable; books load on request. Unresolved operations link to recovery controls in the relevant
     agent's existing route, labeled **Operation status**, with a return to shared Activity.
4. Open the payout agent (**Payables**). Its main tasks are Payments and Agreements, with the same named
   area utilities and shared Activity. Payments shows attention items and one queue for payments and
   local invoices. **Needs review** puts older review items first; **All records** retains recorded terminal
   outcomes. Search matches recorded recipients and references locally, without reading every payment's
   live status. Incomplete checks remain visible in both views. **Create payment** opens the existing
   form and confirmation flow. An invoice joins its payment only when it
   records a provider correlation ID; a prepared or refused invoice retains its own identity. Open
   **Review payment** to inspect exact terms and approval status, including whether the payment
   is within the payee's recorded agreement terms. The locally prepared detail separates **Owner decision**
   from **Payment outcome**; approval alone does not establish processing or completion. Current agreement
   terms remain visible after settlement but do not establish which terms applied to that payment.
   Prepared-invoice cancellation is separate from expandable identifiers and retains its confirmation,
   executor, permission and successful-read restrictions. Provider evidence and payment history are expandable. Payables' `test/browser/payments.cjs` checks
   these distinctions and retained payment links offline. Payouts are approvable for 24 hours. Releasing one files a proposal, and nothing is paid
   until the DAO votes. **Agreements** groups requests, offers and active terms by recipient, showing
   policy inclusion separately. Completed records remain in history, and **Offer terms** opens
   the form on demand. Agreeing records the terms and files the policy update that lists the payee. Direct payee setup is
   under **Add a payee without agreement terms**; it changes the policy without recording terms.
   When no treasury account is linked, the funding controls in **Balances & funding** lead with a deposit address and keep optional
   account linking under **Link a treasury account**. Missing that link is not a send blocker.
   The locally prepared Treasury UI keeps outgoing-payment controls under **Send money to a payee**.
   On the locally prepared invoice page, existing agreements appear before the amount fields;
   **Use these terms** fills an owner's offer without submitting the invoice.
5. On each area's entry page, read **Known limitations** and expand the running brief under
   **requirements and evidence** to see who enforces each guarantee, how each requirement is known,
   and its evidence. Saved `#evidence` links still open the brief. History is in shared **Activity**;
   entry pages no longer repeat a Recent activity list. Roadmap briefs stay in the planning docs.

## The live moment: one invoice, end to end (Facilitator)

This is the one flow worth running in front of people. It joins the three views: a payee submits, the DAO checks
and votes, and the agent pays confidentially.

1. As the payee, submit a small invoice (step 2 above).
2. As a member, open **Review payment** on the payout agent's Payments page and approve it there. A member who may both propose and vote files the
   proposal and votes in one wallet confirmation; anyone else files a proposal for the DAO to vote on.
3. On the home page, "What am I voting on?" shows it with its hash verified. If it still waits for votes, vote in Trezu.
4. The payment settles in the payout agent's Activity a minute or two later.

**With a new payee** (two votes, so rehearse it as a sequence): the payee's first submission is an agreement
request. On **Agreements**, agree to its terms: that files a policy update for the DAO's vote. Policy edits have a
10-minute cooldown, and two owner actions pending at once can collide, so file one at a time. Once it passes, the
payee files the invoice from the request, and steps 2–4 follow. Consult the
[Payables evidence and gaps](docs/facilitator.md) for its verified stage. Record new observations in
[docs/mainnet-log.md](docs/mainnet-log.md), update the inventory, then run `pnpm evidence:write`.

**The approval window is about 5 minutes.** Releasing a payment prepares a signature request, and the API's signing
window closes about five minutes later; the proposal's description says when. Vote in Trezu right after filing.
On 2026-10-12, a payment approved within minutes (proposal #47) was paid. One approved an hour after it was held
(#46) failed, but its wallet was empty, so the window isn't shown to be the cause
([log](docs/mainnet-log.md#invoices-2026-10-12)).

**Recovery.** A fresh invoice creates a new payment. Before replacing one, establish that the original
was refused before submission or that provider execution evidence proves it cannot pay the recipient.
A generic `FAILED` status, an expired approval or an empty wallet is insufficient on its own. The current
code treats `FAILED` as terminal; it does not independently establish that replacement is safe.
See the [recorded limitation](docs/enforcement.md#recovery-limitation).

- **A vote missed the window:** check the existing approval first. An attempted signature is poll-only
  after an ambiguous response or restart. Prepare a fresh approval for the same held payment only after
  establishing the prior request cannot execute; expiry alone must not trigger resubmission.
- **The payout agent refused an invoice** (for example, a payee the DAO no longer agrees to pay): it is resolved as
  refused, and nothing was sent. The payee may submit a new one.
- **A payment failed at the provider after the vote:** reconcile the original operation and inspect
  its execution evidence before deciding whether a new invoice is safe. For the 2026-10-12 22:17Z
  payout, the provider reported `FAILED` with the reason redacted. The empty wallet
  afterwards suggested insufficient funds but did not prove non-execution.
- **Unknown outcome:** the payout agent blocks new sends until the original outcome is established.
  Reconciliation polls a known operation ID; without one, provider/operator investigation is required.
  Never resubmit an unknown payment.

### Balance check

In the current deployment (above). A payment or invoice is refused with `insufficient_balance` when the
payout wallet's confidential balance, less payments this executor holds for approval, is below its amount, so it never
goes to a vote. The refusal is final and nothing was sent: funding the wallet doesn't revive that invoice. Fund the wallet, then have the payee
submit a new invoice. It's a limited check:
- It isn't checked again at approval: a wallet emptied while a payment is held still fails after the vote. The
  provider's reported balance still includes payments held for approval (mainnet, 2026-10-13,
  [log](docs/mainnet-log.md#a-held-payout-stays-in-the-reported-balance-2026-10-13)), so subtracting them doesn't
  count them twice.
- It counts only payments held in this executor's own log. Payments held before that log existed, or by another
  instance, come from the API's history and don't reduce the balance it checks.
- It doesn't guarantee settlement after approval.

## The autopilot moment: a rebalance inside the limits (Treasury Management)

Balances in, a plan out, two quoted swaps inside the caps, and the budget meter dropping. Three assets need at
most two swaps to rebalance, so two is the honest number. Nothing signed changes.

1. Pick a day with budget room: Policy shows the daily USD budget, and Strategy the autopilot's ceiling per
   run, which is about what the run needs.
2. Just before, fund the treasury agent with USDC from the DAO (Funding → money in), enough to put USDC over its
   target by about that ceiling. Portfolio's Allocation shows the gap.
3. Strategy → preview: the plan should show two legs, USDC → wNEAR and USDC → ETH, each above the minimum leg,
   totalling no more than the ceiling, each with its quote's worst cost under the strategy's cost cap. Prices move:
   if the total is over the ceiling, the autopilot would leave it for the owner, so adjust the top-up and preview
   again.
4. Open the run view from **Strategy**, then choose **Run now**. Inspect each recorded send’s
   outcome and the before/after budget in the run view; Activity lists the operations with their policy
   revision and digest. A recorded run end alone does not prove every send settled.

## What keeps it safe

- The agents run under rules the DAO approved, and changing those rules takes a DAO vote.
- Each agent has exactly one executor: the `dao` service for the treasury agent, the `invoices` service for the
  payout agent. Every other instance is approve-only.
- The public page reads nothing from the server. Private treasury data reaches admitted owners/members only;
  money controls require execution permission and retain the signed policy/grant checks.
- Sign-in is bound to each site's host: a signature made for another site can't be used.
- State lives on each service's volume and survives a restart. To check, run `pnpm smoke` with `SMOKE_COOKIE_FILE`
  and `SMOKE_SNAPSHOT` before and after (see `src/smoke.ts`).

## What it doesn't guarantee

Say "autonomous rebalancing with application checks and provider-enforced limits", not "the agent can never exceed
its signed policy". At the custody level:
- What a swap buys is checked only by this server, not by the provider.
- The provider serializes spends per wallet (per its own tests), but whether that holds until usage is recorded,
  for swaps that settle later, is unconfirmed: strict per-asset limits aren't established.
- The provider's USD-budget atomicity hasn't been independently verified.

The plan is in `docs/enforcement.md`.

How the server keeps its own sends safe on one host (the journal, crash recovery, owner-action locking) and what
tests that is in [docs/architecture.md](docs/architecture.md#how-the-money-path-stays-safe-on-one-host); the tests and what deployment shows are in
[enforcement](docs/enforcement.md#local-crash-and-concurrency-recovery).
