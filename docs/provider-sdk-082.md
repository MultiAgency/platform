# Provider SDK 0.8.2 in platform/SDK 0.5.6

The platform pins `@near-intents-agent-api/sdk` to **0.8.2** in `package.json` and `pnpm-lock.yaml`. Its release-age
exception is scoped to that exact package version. Node 24 is required. No existing state is converted and no new
spending capability is exposed by this dependency update.

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

## Compatibility and permission boundary

The old policy output schema rejected the new action. A regression reproduced an overview failure before widening
that read schema. Policy reads and owner previews now retain the `limit_order` action and its optional price-deviation
setting. Unrelated policy edits preserve both. An older app SDK can reject a policy containing this action; consumers
with exhaustive action switches need to handle the additional value. This changes evidence reading, not authorization.

Default Treasury, Payables and Market policies still omit limit orders and native signing. The router, app scopes,
owner request inputs, journal methods and one dispatch/send path gain no order or native-signing operation. There is
no order fill/cancellation lifecycle or cumulative accounting for native signatures in the platform. Integrating those
features requires a separate design, owner permissions, recovery/approval semantics and regression coverage.

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
