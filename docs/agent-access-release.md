# Agent access and chosen-swap release

Prepared locally; not deployed. Release Proto's shared authorization and `externalPlan` together,
then distribute Treasury's `skills/treasury` client. The client must refuse chosen-swap preparation
on an older host; streamed `rebalance` is never a fallback.

## Commit boundaries

The Proto commit contains shared credential lifecycle, consent/access UI, machine routing,
chosen-swap preparation, tests and this release documentation. Its changes to `CONTEXT.md`, the
shared allowlist and member-access tests exclude concurrent Payables/demo additions. Existing
execution, provider policy/grant enforcement and the single guarded dispatch path remain intact.

The coordinated Treasury commit contains only `skills/treasury/SKILL.md`, `references/api.md`,
`scripts/treasury.mjs` and `scripts/package.json`. It does not ship the experimental Treasury gateway
or any other pending Treasury changes. The helper pins `@orpc/client` to `2.0.0-beta.43` and requires
Node 24+. Installing the skill grants no authority.

## Acceptance and review limits

The isolated Proto candidate was constructed from HEAD plus only the release changes, excluding
unrelated working-tree edits. Its offline suite passes 786 tests; the combined working tree previously
passed 793. These counts differ because concurrent Payables tests are not part of this release.
Typecheck, generated-evidence consistency, shared-access browser checks and simulated-provider
consumer tests validate the local candidate. Retain the test manifests and their source/client hashes
with both final commit IDs in the private release record.

Consumer tests cover exact chosen swaps, independent permissions, replay refusal, provider-outage
revocation, host/owner isolation, unavailable support without fallback, lost first/second swap responses,
and a helper process killed after its first success. Killing the helper can leave the admitted server
execution running. Unknown outcomes block new sends. These are simulated-provider observations,
not live-provider, distributed-fencing or screen-reader-hardware acceptance.

## Operator-controlled deployment

1. Confirm the final Proto commit and coordinated Treasury skill commit. Use a clean checkout of the
   Proto commit for the build; do not upload either repository's mixed working tree. Record the current
   deployment/image ID for rollback. Confirm the existing Railway project, environment and `dao`
   service from the deployment context; do not create a service or change host assignments.
2. Confirm no unattended run or freeze is active. Follow the stopped-writer backup procedure in
   [operations](operations.md). Preserve the existing `/data` volume, settings, session secret, host
   registry, supplier routes and executor assignments. Preserve every state directory in
   the canonical list of [operations](operations.md): `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/`, `.hosted/`, `.agent-connections/`, `.machine-auth/` and `.app-access/`,
   including plan execution claims and all revocations. This release
   requires no conversion of existing records and must not initialize replacement identities.
3. Package the reviewed Proto commit with `scripts/package-shared-frontends.mjs`, supplying the
   verified currently deployed Treasury and Payables frontend artifacts. Build Proto's own frontend
   from the reviewed commit. The live four-domain service uses the packaged root Dockerfile from
   `Dockerfile.gateway`, not `Dockerfile.payouts` or a single-frontend
   dashboard image. Verify every preserved product asset and `deploy/shared-frontends.json` against
   the current deployment. Retain the effective root Dockerfile setting, one replica, zero overlap,
   `/data` mount and `DASHBOARD_FILE=/app/deploy/shared-frontends.json`. Gateway and loopback agent servers must use the same release.
   Preserve Treasury's executor assignment and payout's approve-only assignment on `dao`; the existing
   payout executor remains on the invoice service. Do not restart or redeploy that service for this feature.
4. Check health and the existing read-only smoke checks from the reviewed checkout. Inspect the shared
   access page with an existing host-local session: listing must not issue credentials or sign actions.
   Confirm other hosts and supplier routes retain their prior behavior. An unavailable observation is
   not permission to bypass ownership evidence or create replacement authority.
5. Distribute the exact Treasury skill commit after the compatible Proto deployment is confirmed.
   Live credential issuance, owner signing and any funded execution require separate explicit user
   authorization. Do not use `pnpm test:live` as a release health check.

## Rollback

If validation fails, stop admitting new machine calls before the user-controlled rollback. A client
exit, revocation or deployment rollback cannot cancel an operation already admitted by the executor.
Inspect existing journals and unresolved outcomes before further money actions; do not retry an
unknown execution or prepare replacement sends as an automatic recovery step.

Restore the previously recorded code/image while retaining the latest volume and settings. Never
restore older revocation records, remove `.executed` plan claims, clear unresolved journals, or copy
credentials to another host. If state compatibility cannot be established, keep machine access
unavailable until reviewed. Existing browser and supplier functionality must not be replaced with the
experimental Treasury gateway. Older code lacking `externalPlan` intentionally leaves chosen swaps
unavailable, including for clients holding otherwise valid credentials.
