# First-owner release preparation — historical

This document records the earlier candidate and its offline coverage. For the released
shared-frontend artifact and hosted observations, use [proto-release-execution.md](proto-release-execution.md).
The new-owner money journey below was not executed during that release. Its deployment
commands and configuration are historical and must not replace the reviewed r2 procedure.

## Validation boundary

`test/browser/first-owner.cjs` runs one continuous Payables journey for each of a fresh wallet
owner and a fresh Sputnik DAO owner: host-bound sign-in, reservation, policy creation,
interrupted creation recovery, grant, funding, short demo, explicit payment confirmation,
interrupted submission recovery, exact-record approval and settlement observation, then a fresh
sign-in on the full Payables domain and reopening that same payment. Cancelling confirmation
sends nothing. Reloading never prepares another owner action or payment. Approval alone does
not establish settlement.

The actual frontend and wallet connector run against simulated gateway, provider and chain
responses. This is automated usability-path coverage, not evidence that an unaided person has
finished, nor real signing or mainnet settlement evidence. Treasury and purchase-order browser
coverage remains separate; this test does not claim continuous journeys for all three ideas.
The real-gateway offline tests and application E2E suite provide separate backend coverage.

The continuous test exposed a setup panel disappearing after navigation to Policy. The candidate
keeps its next step visible and directs an empty, observed balance to funding before the demo.
Existing confirmations and exact payment identities remain intact.

## Artifact and configuration

Run `pnpm verify:candidate` after review. Its immutable source directory, `manifest.json`,
`verify.log` and `result.json` under `.test-artifacts/candidates/` identify exactly what passed.
Only that captured source is eligible for this rollout. Concurrent working-tree changes require
review and another candidate; they are not silently included. No release commit is implied.

Build the `dao` image from a package of the captured source (`scripts/package-shared-frontends.mjs`, whose root
Dockerfile is `Dockerfile.gateway`), not from the repository's `railway.json`, which selects `Dockerfile.payouts` (the
invoice service image). Pin the resulting image digest in the private release
record before deployment. The current Docker base tag is mutable; record the resolved base digest
and final image. The optional independently built frontend is not enabled by this rollout.

For dao: `DASHBOARD_FILE=/app/deploy/shared-demos.json`, unset `DASHBOARD_HOST`, retain
`SESSION_SECRET`, existing settings and `/data` volume, `PORT=8080` matching the domain target, one replica, no deployment overlap.
Require a stopped old writer before starting the replacement; configuration alone is not fencing.
Do not alter the root Railway file used by invoices. Confirm the effective service build uses
the packaged gateway Dockerfile and `/health` before releasing. Keep all existing executor assignments.

## Refreshed read-only baseline

At 2026-10-15 21:22 UTC, HTTPS health checks succeeded for all four custom domains and the
three retained generated domains. Railway reported one replica per service and these deployments:

| Service | Deployment | Existing /data volume ID |
|---|---|---|
| dao | f3c78026-3826-4380-a94a-9947277b38fa | b6d32745-3bc2-4de7-b801-5eb821df73b5 |
| invoices | 36112adc-5fec-49a7-8ff0-657d3af3cd16 | 396f02bc-3836-4f39-98b8-06fbc59f1306 |
| treasury | 07c31669-3ebe-4cc2-ba93-a87009e16c51 | db3ab1f9-2122-44f6-84bb-cdca3fc7cafc |
| payables | 083e4cd0-c940-4480-a3c7-cf3756319edf | e2c627aa-7c9b-4c2f-a5bb-70124cdb64f9 |

Read-only process inspection and hashed agent identity comparison confirmed the dao payout
instance matches the invoices executor. Dao payout is approve-only; invoices executes. Dao's
Treasury executor and the standalone Treasury child have distinct identities. Retain both.
No standalone Payables child was observed; its volume still must be preserved. This is not an
audit of current unresolved operations, active schedules or every historical owner record.

Generated Treasury and Payables challenges still name their custom domains. Therefore these
are healthy endpoints, **not verified fallback sign-in**. Before moving either custom domain,
prepare the retained installation's generated-domain signing configuration using its own source,
obtain authorization for its restart, and verify owner access. Stop the rollout if that fails.

## Staged authorization and rollback

Use [the shared-domain rollout](shared-demos-rollout.md) for the domain map and detailed order.
Production authorization must cover: a maintenance window; stopped-writer backups; standalone
fallback configuration/restarts; dao image/configuration replacement; and moving the three custom
domain attachments and their exact Railway-provided DNS records. No state import or agent migration.

Before stopping writers, privately record live schedules, unresolved operations, attempted owner
signatures, settings, domain/DNS attachments and exact image digests. Freeze new intake during the
backup window. Back up each complete volume with writers stopped, retain nested settings and all
journals/registries listed in the rollout document, checksum the backups, and demonstrate a restore
to an isolated directory. Backups have not been taken by this read-only review.

Keep invoices on its current executor, grant, volume and signed public host. Retain the standalone
Treasury agent and both standalone registries. Start only one replacement dao writer after the old
one is stopped. Verify host-bound sessions, unchanged owner/policy/grant identities, exact record
links, supplier routing and executor inventory before opening intake.

Rollback stops the replacement dao writer, restores the pinned old image/configuration and original
domain attachments, and restores standalone signing hosts after their domains return. Preserve all
current state, including records accepted after rollout. Never restore a stale journal over later
work or replay an attempted signature/payment. New reservations may require the candidate's reader;
if the old image cannot read them, keep their state and disable new intake pending forward recovery.

## Proposed separately bounded live walkthrough

After read-only acceptance, request a specific wallet owner and owner-controlled recipient plus
`agentic.sputnik-dao.near`. Create at most one new Payables agent per owner. Operational limits:
at most 1 USDC funded per agent, one payout at most 0.10 USDC per agent, and at most 0.5 NEAR total
network/storage cost. Stop before any request exceeding those caps. These walkthrough limits are
not claims about the default provider policy; inspect and approve the actual policy and grant.

Every owner signature and payment retains its explicit confirmation. Autopilot remains off for
these new agents. No swaps, supplier conversion, existing-agent payments, unattended runs or
money-action retries. Observe the exact record through completion and reopen it in the full app.
Unknown outcomes stop the walkthrough and remain unresolved. Revoking new grants or returning
remaining funds requires separately confirmed owner actions; do not silently clean up balances.

Remaining requirements: production Railway configuration/domain/deployment access, DNS-zone write
access, stopped-writer backup/restore access, retained standalone owners for fallback checks, and
wallet/DAO signing authority plus the chosen recipient. Read-only access is demonstrated; these
write permissions and owner approvals are not. No production changes or live money actions have
been performed for this candidate.
