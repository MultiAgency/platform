# Proto shared infrastructure release review

Review refreshed 2026-10-16 UTC. This document updates the frozen r2 review's
standalone acceptance findings; it does not modify that artifact or authorize production actions.

## Candidate and acceptance

Deployable source: `/tmp/proto-infrastructure-review-20261015-r2.tar.gz`.
SHA-256: `0add241b3d4d645627f1ed2bbb48666fbb3c5cf48f75776f204230faa0577e4e`.
All 220 review-manifest entries were rechecked and match. Each packaged sibling
frontend matches all 28 files of its current local `web/dist`. Use the archive,
not the concurrently edited checkout. No repackaging is required by the standalone fixes.

The frozen RESULTS.md records 743 offline tests, both independent frontend journeys,
and a network-disabled image check of 195 runtime hashes and synthetic restart preservation.
These are offline results, not hosted authentication or settlement evidence.
The Payables browser journey was rerun successfully against a fresh extraction of
the frozen archive during this review, including static/managed supplier links and
exact work-order IDs. The first attempt lacked local dependencies; the fresh
extraction used the existing local dependencies without changing candidate bytes.

Treasury release `e2c237bf-7d8b-4c4e-9e5d-b43030e14117` passed both-host
owner sign-in, existing-agent access and two retained private-record checks, with
original state and executor assignment preserved. Evidence:
[Treasury acceptance](https://github.com/MultiAgency/treasury-prototype/blob/cea2eab2b414ddd32f65857ac4683fe9823e215a/docs/treasury-release-acceptance.md).

Payables release `360625c3-2589-4d80-be89-f8ecad0186db` passed both-host
sign-in and authenticated reload. Its execution receipt records zero registrations
and empty authenticated workspaces on both hosts. Existing private-agent access was
not established; do not describe it as passed or create an agent to manufacture evidence.
Evidence remains in Payables' private `.test-artifacts/maintenance-window-20261015/execution-result.json`.
Both standalone releases passed their stopped-volume backup/restore procedures.
Neither moved domains or copied registrations to Proto.

Read-only Railway status independently confirmed both releases SUCCESS, one active
deployment each, and unchanged custom-domain attachments. Their browser acceptance
is taken from the sibling evidence, not repeated by this review.

## Exact target and configuration

Project `0c5d641c-592a-47f4-8606-48d07a91d276`, production environment
`5faa8323-d967-46c3-8f49-4bfe1a68f139`, dao service
`4bf56a31-b642-4e3c-973d-77b3a9e58f2d`.

Current dao deployment is `f3c78026-3826-4380-a94a-9947277b38fa`, SUCCESS,
image `sha256:e19141d2467212584130b5fafe11f27936dd0e8a8b5a781dd373e8e470a63faa`.
This is the rollback identity to refresh before maintenance; status alone does not
establish rollback eligibility. Current metadata selects `Dockerfile.dashboard`,
ALWAYS restart, one replica, `/health`, no start override, and null overlap.

The frozen archive intentionally selects root `Dockerfile`, ON_FAILURE with five
retries, one replica and `/health`. The release decision must include these changes;
they are not configuration preservation. Verify effective Railway configuration
uses the archive Dockerfile and explicitly enforce zero overlap. Preserve other
service settings and the original volume. Set
`DASHBOARD_FILE=/app/deploy/shared-frontends.json`, unset `DASHBOARD_HOST`, and
retain SESSION_SECRET and private agent settings. Record previous values privately.

Railway source upload avoids GHCR and additional tokens. A Railway build produces
its own image identity; record and verify it rather than equating it with the local
review image. Upload only the extracted archive to dao with explicit IDs and
`--path-as-root`; never upload this context to invoices or either standalone service.

## Routing and state boundaries

| Host | Target after authorized rollout | Assets or route |
| --- | --- | --- |
| proto.multiagency.ai | dao, port 8080 | `/app/web/dist` |
| treasury.multiagency.ai | dao, port 8080 | `/app/frontends/treasury` |
| payables.multiagency.ai | dao, port 8080 | `/app/frontends/payables` |
| invoices.multiagency.ai | dao, port 8080 | Supplier routing, existing upstream retained |

Treasury's reference hostname is treasury.multiagency.ai. The standalone Treasury
agent remains at treasury-production-c98c.up.railway.app; moving the custom hostname
does not migrate that agent into Proto. Payables retains payables-production.up.railway.app.
Existing standalone bookmarks may need the retained hostname and a fresh sign-in.

Static payout discovery explicitly advertises `https://invoices.multiagency.ai/submit`.
Managed intake uses `/i/<instance>/`; exact workOrder identifiers and existing query
fields must survive navigation and reload. Missing mappings refuse. The invoice
upstream remains `https://invoices-production-d3bb.up.railway.app`, with its canonical
signing host retained. Supplier routing changes must never replay a submission.

Dao's Treasury executor stays on dao; its static payout stays approve-only.
The payout executor stays on invoices. Standalone agents retain their own distinct
executors and volumes. No .treasuries/.payables import, grant copying or state
conversion is included. The lock is single-host coordination, not distributed fencing.

## One authorized release sequence

1. Refresh dao rollback eligibility, effective configuration, volume identity and
   private agent/record/executor baseline. Capture all original domain attachments
   and DNS values. Check schedules, unresolved operations and other writers.
2. During the authorized maintenance window, stop dao writers and verify they exited.
   Back up the whole dao volume and validate an isolated restore before replacement.
   Preserve settings and all nested state, including journals, owner intents, evidence,
   invoices, work orders and hosted registrations. Reuse the successful standalone
   maintenance approach if needed; do not invent a registry requirement. Keep intake
   closed until acceptance, and retain all existing records throughout the window.
3. Source-deploy the frozen context to dao on its original volume with the reviewed
   configuration above. Observe the submitted deployment reach SUCCESS, record its
   image identity, and compare packaged application/assets before domain changes.
   Confirm one executor per agent and the retained private baseline on Proto.
4. Move the three approved custom-domain attachments to dao port 8080, keeping Proto
   attached. Use only provider-returned DNS records. Keep the invoice upstream and
   standalone services running in their existing roles. Do not restart unchanged
   executors or move their volumes. Verify TLS and routing at each step; on partial
   failure restore the captured attachments rather than opening incomplete intake.
5. Coordinate visible owner sign-in on each new host; verify discovery, expected
   private access and signed-out denial. Recheck standalone fallback access. Inspect
   supplier routing and existing work-order links with exact IDs and reload, without
   submitting a payment. Offline synthetic supplier records are not live acceptance.
   If no suitable live record exists, report that limit separately. No agent creation,
   grant, owner money action or live-funds test is authorized by this procedure.

## Rollback

Stop the replacement dao writer before restoring the pinned prior image and captured
configuration on the same current volume. Restore the original domain attachments
and DNS; Treasury and Payables stay on their accepted r2 standalone releases, including
their sign-in aliases. Do not undo those fixes. The invoices executor and volume stay put.

Preserve all post-release state. Never restore a stale backup over accepted records,
discard unresolved work, or replay signatures/submissions. If newly accepted hosted
records cannot be read by the previous image, keep intake closed and use forward
recovery rather than silently orphaning them. Recheck TLS, sign-in, original private
records and executor assignments after recovery.

Remaining gates are an authorized Proto window, its fresh baseline and recoverable
backup, effective build/configuration verification, and hosted acceptance. Payables'
empty-workspace limit remains explicit; no existing-record continuity claim is made.

Guidance: the use-railway skill,
the frozen r2 review, and this repository's AGENTS.md state/executor requirements.
