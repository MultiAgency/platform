# Provider SDK 0.8.2 in platform/SDK 0.5.6

The platform pins `@near-intents-agent-api/sdk` to **0.8.2** in `package.json` and `pnpm-lock.yaml`. Its release-age
exception is scoped to that exact package version. Node 24 is required. The tagged 0.5.6 dependency update converted
no existing state and exposed no new spending capability. The tagged 0.5.7 SDK also lacks order routes. A separate
Treasury [limit-order feature](limit-orders.md) is in progress for SDK 0.5.8.

## Source review (2026-11-10)

Reviewed the official SDK diff from `bddab8b3841111850e863e5e2a6696c7e9520814` (0.8.0) to
[`416597b0c63a426b225b98b6d175c03bfb6a7947`](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/commit/416597b0c63a426b225b98b6d175c03bfb6a7947),
including its [changelog](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/blob/416597b0c63a426b225b98b6d175c03bfb6a7947/CHANGELOG.md),
client, request idempotency, errors, generated routes and API types. The official Agent API skills at
[`0b81bba6fca6356a2db81d0ede08e9cb928d08e1`](https://github.com/NEAR-Intents-Agent-API/skills/tree/0b81bba6fca6356a2db81d0ede08e9cb928d08e1)
were checked for policy, owner actions, execution and recovery. These are public source/interface evidence, not a
claim that those commits are deployed. The API coordinator implementation was not available for inspection.

- **0.8.1:** limit-order placement, reads and cancellation; policy action `limit_order`, optional
  `limit_order.max_deviation_bps`, richer execution evidence and `DeletionPreview.open_limit_orders`. A limit order's
  `SUCCESS` means funded/resting, not filled. Existing transfer, withdrawal, swap and owner-action methods keep their
  transport shape. The idempotency change adds keyless limit-order dry previews; live existing requests keep their
  original idempotency behavior. `AgentApiError` runtime fields are unchanged.
- **0.8.2:** optional `one_click_quotes` and `OneClickQuote` for EVM/Solana `sign-intent`. Per upstream docs, 1Click's
  signed quote proves a deposit address and bounds loss at `minAmountOut` including fees; confidential deposits can
  be used. These are NEAR Intents transfer payloads, not the NEP-366 delegate the market requires. These native
  signing paths have different policy protections from our dispatch path and are not integrated here.

## Deployed read and preview checks (2026-11-10)

The authenticated demo provider served limit-order reads and a dry preview. At **22:38 UTC**, one dry **BUY** preview
returned HTTP 200 with `dry: true`, `type: "limit_order"`, and a `quote.spend_asset` and `quote.spend_amount` matching
the exact atomic quote-spend formula in the [pinned limit-order reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/0b81bba6fca6356a2db81d0ede08e9cb928d08e1/near-intents-agent-api/references/limit-orders.md).
The preview also warned `policy_action_denied`, `policy_price_deviation_exceeded`, and `insufficient_balance`: it did
not authorize placement. No live placement, fill, payout, or cancellation was attempted. The production provider did
not support these limit-order routes in the read-only check. A working demo route does not identify the deployed
provider commit or prove live money-path behavior.

## Compatibility and permission boundary

The old policy output schema rejected the new action. A regression reproduced an overview failure before widening
that read schema. Policy reads and owner previews now retain the `limit_order` action and its optional price-deviation
setting. Unrelated policy edits preserve both. An older app SDK can reject a policy containing this action; consumers
with exhaustive action switches need to handle the additional value. This changes evidence reading, not authorization.

In the tagged 0.5.6 and 0.5.7 releases, default Treasury, Payables and Market policies omit limit orders and native
signing; the router, app scopes and dispatch path expose no order or native-signing operation. The unreleased 0.5.8
limit-order change adds an owner-signed per-order permission, an explicit `treasury-orders` app consent, an opt-in
policy action, guarded placement through `dispatch`, and retained fill/cancellation observations. This change is in progress and
has focused offline tests only; it has not been placed on mainnet through the platform. Native signing remains outside
this change and has no fill/cancellation lifecycle or cumulative accounting here. See [Treasury limit orders](limit-orders.md)
for the exact boundaries and evidence.

No new error classification is inferred from an SDK update. In particular `policy_price_deviation_exceeded`,
`market_price_unavailable`, `limit_orders_open` and the newer `invalid_address` at 409 do not prove that an attempted
send did nothing. The existing conservative refusal rules and unresolved-operation blocking remain in place.

`test/upstream-compat.test.ts` covers the provider policy through the real router, preservation on an unrelated policy
edit, and refusal of new paths by existing app scopes/permissions. `test/money-safety.test.ts` checks the actual SDK's
single transport attempt and retained key on a lost response, and keeps unfamiliar errors unproven. The full offline
release gates also exercise the upgraded SDK against simulated provider/chain/wallet/market services. These tests do
not establish provider deployment, order fills, native signature safety or mainnet behavior.

The existing [shared market-state downgrade boundary](market.md#rollback) still applies. Preserve every state directory
and settings file with executors stopped; this SDK upgrade does not make an older host compatible with market records.
