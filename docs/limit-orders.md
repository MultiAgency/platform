# Treasury limit orders

**Status (2026-11-11): separate feature in progress.** The tagged SDK 0.5.6 release does not expose limit-order
spending. The new Treasury path has focused offline tests, but no order has been placed, filled, paid out, or canceled
on mainnet through this platform. The production provider did not support the limit-order routes in the read-only
check. Do not treat a dry preview or placement `SUCCESS` as a completed trade.

## Evidence and provider meaning

The [official Agent API limit-order reference pinned at `0b81bba6`](https://github.com/NEAR-Intents-Agent-API/skills/blob/0b81bba6fca6356a2db81d0ede08e9cb928d08e1/near-intents-agent-api/references/limit-orders.md)
and [SDK source pinned at `416597b`](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/commit/416597b0c63a426b225b98b6d175c03bfb6a7947)
describe the interface. They do not identify the running provider build. The SDK exposes a keyless dry
`placeLimitOrder`, grant-bound live `placeLimitOrder` and `cancelLimitOrder`, and live `getLimitOrder` and
`listLimitOrders` reads. Its `quote` field is open-ended, so this platform checks the spend fields explicitly.

**Deployed demo observation, 2026-11-10 22:38 UTC:** one authenticated dry **BUY** preview returned HTTP 200,
`dry: true`, and `type: "limit_order"`. Its `quote.spend_asset` and `quote.spend_amount` matched the exact atomic
quote-spend calculation below. It also returned warnings `policy_action_denied`,
`policy_price_deviation_exceeded`, and `insufficient_balance`. The dry call spent nothing and did not show that a live
order would be accepted. Authenticated reads and previews worked on demo; production did not support these routes in
the read-only check. No live placement or cancellation was attempted.

`quantity` is atomic **base** units; `price` is positive plain decimal **quote units per whole base unit**, at most
40 characters, with no exponent. If base and quote have `baseDecimals` and `quoteDecimals` from provider token
metadata, a sell spends exactly `quantity` atomic base units. A buy spends the ceiling of
`quantity × price × 10^quoteDecimals / 10^baseDecimals` atomic quote units. The local calculation uses integers and
decimal digits, never floating point. Missing token decimals, an ambiguous asset pair, a nonpositive quantity or
price, or a dry quote whose spend asset or atomic amount differs refuses before any live placement. The pinned
reference names `quote.spend_amount` but does not explicitly label that field's unit; the deployed dry BUY result
matched this atomic interpretation. Every proposed and placed order must match its own fresh dry preview.

Per the pinned reference, the provider allows an omitted deadline and then defaults to seven days. The platform
requires an explicit future deadline more than one minute and at most seven days away, so no order rests indefinitely
by omission. The owner also gives the approval an expiry no later than the order deadline.

## Owner permission and application boundary

The default Treasury policy has no `limit_order` action. The owner must opt in by signing a policy revision that
allows `limit_order` and sets `limit_order.max_deviation_bps` within the SDK's 0–300 range. The provider remains the
enforcer of its asset caps, action permission, price-deviation rule and USD budget; the platform does not infer that
enforcement from a preview. A live Treasury grant is also required for placement and cancellation.

A separate app consent scope, `treasury-orders`, requires `treasury`. Existing Treasury consent alone does not
permit these methods. Each order is then an immutable proposal tied to the app actor and consent, agent, exact base
and quote assets, side, atomic quantity, decimal price, deadline, confidential funding, spend and output assets,
policy revision and digest, and Treasury strategy digest. The owner signs the proposal's exact canonical text with
NEP-413 for **each** order. The gateway must verify the signing key's owner authority; the agent verifies the signed
text and recipient before recording approval. Autopilot cannot place an order, and the strategy cash floor currently
refuses resting orders because its exposure cannot be checked as one completed swap.

For a DAO owner, the app files an exact approval or rejection vote through `dao-limit-orders`; the gateway relays
the found DAO signature once after checking the agent and key again. This is an offline-tested platform route. The
gateway records a relay only when the agent returns the matching order and a digest of that exact saved signature.
It durably claims the one allowed relay before the HTTP call. If the reply is lost, later polls reread the agent's
receipt without submitting the owner signature again; an unproven claim stays unresolved for review. The current
Treasury app consumer still needs its own DAO member and vote flow.

## Placement, observation, and recovery

Creation and placement use dry previews and refuse warnings. Immediately before a live placement, `dispatch`
holds the money lock, checks that no prior operation is unresolved, rereads policy, strategy, grant and token
metadata, recomputes the exact spend, and compares a fresh dry quote. It claims the owner-approved proposal once,
writes a versioned operation and submission claim, then makes one grant-bound `placeLimitOrder` call with the stable
key `limit-order:<proposalId>`. A changed policy, strategy, terms, output asset, preview or grant refuses before
the live call. These are application checks; the provider policy is still the spending authority.

A provider operation `SUCCESS` establishes a funded/resting order and must carry an `order_id`. The order ID is saved
durably before the journal records terminal `SUCCESS`. Fills and payouts are separate live observations by that ID;
the provider's list can be stale. A missing or changed order ID, mismatched asset/side/quantity/price, unreadable
provider view, or torn observation history is not settlement evidence. Full `partial_fills` and `payouts` data is
retained, rather than reduced to a filled flag.

Per the pinned reference, normalized fill states include `awaiting_deposit`, `pending_cancel`, `untriggered`, `open`,
`partially_filled`, `filled`, `canceled` and `expired`; payout states include `not_started`, `in_progress`,
`completed` and `failed`. Only a closed fill (`filled`, `canceled` or `expired`) **and**
`is_payout_status_final: true` with payout status `completed` is treated as complete. A final payout `failed` needs
review; partial fills and nonfinal payouts remain open. A status that the platform does not recognize remains
unknown. A canceled order can still have partial fills and payouts to track.

An unanswered live placement leaves its submission claimed and its journal operation unresolved, blocking new
sends. Neither the owner nor recovery repeats it: provider deduplication of an ambiguous request is unverified.
If a correlation ID was retained, recovery reads status only and saves a successful `order_id` before terminal
journal status. Cancellation has no provider idempotency key. It is claimed and journaled before one cancel call;
a lost reply is followed only by live reads. Cancellation acceptance alone does not prove final payout. A freeze
may attempt cancellation, but resting fills can still occur, so freeze and agent release must account for every
known order's live fill and payout state. Release checks all locally tracked orders and each provider-listed order
by live ID; the provider list can lag, so an external order omitted from it still needs operator reconciliation.
Before another money action, the lock checks that each successful placement journal line still has its exact
owner-approved proposal, one-way claim, and matching provider order ID. Missing files pause sends for state review.

Order proposal, approval, claim, placement, cancellation and observation records live under
`.proposals/limit-orders/<agentId>/`, beside the existing Treasury proposals. New `limit_order` and
`limit_order_cancel` journal methods are incompatible with older readers. Keep executors stopped and preserve all
state directories and settings for rollback as in [operations](operations.md); an older host cannot be assumed to
read records from this feature. DAO order votes also add `limit_order` requests to `.app-access/dao-requests/`;
a pre-feature gateway may refuse those records during rollback. An attempted DAO vote relay stays retained if its
agent receipt remains unknown, so preserve its claim and reconcile it before removing old gateway state.

## Verification and remaining work

### Treasury app consumer handoff

The Treasury app checkout is owned by another active session. Its server needs to request a **new** consent carrying
both `treasury` and `treasury-orders`; an older Treasury consent has no order authority. Keep the app service
credential on the server and use `appClient(...).agent(organization, agent).call(...)` for the nine `limitOrders/*`
procedures. A host with the Treasury area provides the `treasury-limit-orders-v1` owner-app capability; its manifest
entry grants no consent. The current app's connected state hides the consent form once Treasury access exists, so its UI must
offer the separate order consent explicitly. The existing app is an uncommitted SDK 0.4.0 candidate; it must take
the new contract from a later feature package, not treat the tagged 0.5.6 package as containing these routes.

Save the app's `requestId` and exact terms before `limitOrders/create`; retry only that same body if its answer is
lost. Read the saved proposal by ID and show `limitOrderText(view, "approve")` from the SDK contract before asking
the current wallet owner to sign it. Relay the signature to `limitOrders/approve`, then call `limitOrders/place` once.
If placement's answer is lost, follow `get` and `refresh` by ID; never create a second request to compensate.
For a DAO owner, `appClient(...).daoLimitOrders.file({ organization, agent, order: id, verdict })` files the exact
vote, and `.state(hash)` follows its one-time relay; the app must separately gate its member role and voting UI.
Cancellation is a separate one-time request. After an ambiguous cancel reply, use `refresh` to follow fills and
payouts, never another cancel POST. The UI should label `resting`, `partially_filled`, `cancel_requested`,
`payout_failed` and `unknown` distinctly, and show `completed` only after the provider's final payout read.

The app integration points are `app/server.ts`, `app/treasury-app.ts` and `web/src/proposals/` in the Treasury
checkout. Its other active session should own those edits and tests.

Focused offline tests in `test/limit-order-terms.test.ts`, `test/limit-order-store.test.ts`,
`test/limit-order-dispatch.test.ts`, `test/limit-order-observe.test.ts` and the service/cancellation suites cover exact
spend arithmetic, immutable records, one claimed placement under the money lock, approval expiry across slow provider
reads, preview mismatch, lost replies without replay, status-only recovery, damaged cancellation claims, retained
partial fills and payouts, deduplicated unchanged reads, and rejection of mismatched order views. They use a simulated
provider and do not establish live provider behavior. Gateway tests also cover DAO vote receipts, lost relay replies,
concurrent polls, credential revocation during filing, and malformed successful responses. Missing local order files
block later sends and agent release in offline faults; recovery still polls unrelated unknown operations before
surfacing the missing evidence. The full offline suite passed 1,326/1,326 on this tree;
typecheck, evidence checks and the packed 0.5.7 SDK's Node and Bun 1.4.2 consumer checks passed, including the
existing 21 skill examples. Browser and end-to-end order flows still need the Treasury app consumer and a later
release candidate. Live placement, cancellation, payout behavior, the
production route, and the deployed provider's policy enforcement remain unverified. Native EVM/Solana `sign-intent`
is a separate design with different protections and is not enabled by this order path.
