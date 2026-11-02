# Shared demo backend — historical preparation

The frozen shared-frontend r2 release supersedes this candidate's deployment instructions.
See [proto-release-review.md](proto-release-review.md) for its configuration and rollback
and [proto-release-execution.md](proto-release-execution.md) for actual hosted observations.
The dated candidate notes below retain their original validation boundaries; they are not
current service status or authorization to apply the sibling correction patch.

This repository is the integration candidate for three focused Agent Connect demos,
initially using the existing agents owned by `agentic.sputnik-dao.near`. Proto remains the umbrella showcase. This rollout does
not authorize mainnet experiments, deployment, DNS changes, restarts or state migration.

## Domain and scope

| Domain | Entry | Assigned existing agents |
|---|---|---|
| proto.multiagency.ai | Static explanation of all three ideas; links to their demos and owner workspace | Treasury and payout after sign-in |
| treasury.multiagency.ai | Agency workspace combining idea 02 with confidential payables and isolated work orders | Treasury and payout |
| payables.multiagency.ai | Ideas 01 and 03: confidential intake, agreements, owner-approved payouts and isolated purchase orders | Payout parent; dedicated agent per order |
| invoices.multiagency.ai | Supplier-facing entry into Payables: supplier invoices and payment tracking | Existing invoice executor and work-order agents |

The agency Treasury product combines all three ideas, following the owner’s product direction.
Idea 02 retains its catalog scope: Agentic Treasury Management. Shared infrastructure does not
combine balances or grants. Idea 01 is confidential
payment intake and owner-approved payouts. Both regular NEAR wallet owners and DAO owners are supported;
the catalog brief emphasizes DAO membership confidentiality. Idea 03 includes separate
agents per order and supplier conversion/forwarding. The buyer flow is implemented and offline-tested;
supplier settlement and mainnet work-order verification remain outstanding. See the canonical
[scope audit](../agent-connect-audit.md), [Payables requirements](../facilitator.md) and
[Treasury requirements](../treasury.md). Steward stays experimental and absent from navigation.

## Read-only infrastructure observation, 2026-10-15 UTC

Railway CLI status, volume attachments and process configuration were inspected directly. These are
infrastructure observations, not money-path or provider-enforcement evidence. No funds were moved.

| Service | Custom domain at inspection | Active deployment | Volume | Running responsibility |
|---|---|---|---|---|
| dao | proto.multiagency.ai | f3c78026-3826-4380-a94a-9947277b38fa | dao-volume, /data | Gateway in /data/state; .env.dao executor; .env.payout with EXECUTOR=off |
| invoices | invoices.multiagency.ai | 36112adc-5fec-49a7-8ff0-657d3af3cd16 | invoices-volume, /data | Existing payout executor and invoice listener; signs for invoices.multiagency.ai |
| treasury | treasury.multiagency.ai | 07c31669-3ebe-4cc2-ba93-a87009e16c51 | treasury-volume, /data | Separate self-service installation with an active wallet Treasury child under .treasuries |
| payables | payables.multiagency.ai | 083e4cd0-c940-4480-a3c7-cf3756319edf | payables-volume, /data | Separate self-service gateway; .payables state exists |

All four deployments reported one replica. Treasury and Payables come from sibling source directories
`../treasury` and `../payables`; they are not assumed to match this checkout. The running Treasury
configuration has no static agents, while its self-service child is active. Do not infer an unused
volume or absence of funds from that empty static list. Full state contents and balances were not
exported. Repeated CLI/Node process entries alone do not establish duplicate executors. A later read-only hashed identity comparison confirmed the payout match and distinct Treasury identities; see [the first-owner release record](first-owner-release.md). Recheck the inventory in the maintenance window.

## Architecture and reviewable configuration

Use [deploy/shared-demos.json](../../deploy/shared-demos.json) on **dao**, with the packaged gateway
(`scripts/package-shared-frontends.mjs` → `Dockerfile.gateway`) and existing /data/state. It explicitly assigns four hosts to demos and agents.
Do not replace the default deployment configuration until the rollout is approved. Existing
settings, credentials, record formats, grants and executor assignments are preserved. New owners may
reserve isolated setup instances; no provider agent or grant is created until the owner separately signs.

Attach the four public demo domains to this gateway. Keep **invoices** running on its current volume
and generated Railway domain, `invoices-production-d3bb.up.railway.app`. The gateway streams invoice
requests there once over HTTPS. It does not retry, follow redirects or send dashboard cookies.
The existing invoice session and signed host remain invoices.multiagency.ai. Existing agreements
bearer authorization remains enforced by that backend. This is a public HTTPS upstream, not a claim
of private-network isolation. Its availability affects intake; an uncertain submission requires
reviewing the original invoice, never creating a replacement merely because a gateway call failed.

Retain the independent **treasury** and **payables** installations and all their state. Before moving
their custom domains, the owner must establish working sign-in through their generated Railway domains
using their own source/configuration. Their state formats (.treasuries and .payables) are not imported
into this repository's .hosted registry. Consolidating those existing wallet agents is a separate,
stopped-executor migration. No grant copying or second executor is part of this rollout.

## Routing and security contract

- Actual Host selects a configured demo. Unknown hosts receive 421, except GET/HEAD /health.
  X-Forwarded-Host cannot choose an audience. There are no canonical-host redirects.
- Each configured host signs its own NEP-413 challenge. The dashboard cookie is `__Host-demo_session`,
  Secure, HttpOnly, host-only and SameSite=Strict. Its signing key is derived separately per host;
  copying a cookie to a sibling domain does not authenticate. Old dashboard cookies do not migrate.
- Cross-origin requests are refused, including sibling-origin and HTTP-origin requests. Fetch metadata
  rejects cross-site writes even without Origin. Ordinary cross-site page navigation is allowed.
  SameSite alone does not establish isolation between sibling domains.
- Host assignment bounds session access discovery, proposals, intervention history, scoped pages and
  `/a/<agent>/rpc/*`. Existing owner membership and procedure permission checks still apply on each call.
  `hostedAreas` admits registered instances by area and bounds new owner setup. Self-service verifies
  wallet ownership or DAO membership with proposal permission; reservations reuse one instance per
  owner and area across hosts. Legacy standalone installations remain separate.
- The Proto root showcase is static and makes no gateway or agent request. `/workspace` performs host-bound
  admission. Signed-out gateway discovery returns no agents and makes no owner/provider reads.
- Scoped record URLs retain their query strings; they never redirect to another agent or record.
  Invoice `/`, `/api/*`, `/internal/*`, `/invoice-browser.js`, `/submit` and legacy `/?workOrder=...` reach
  the original invoice handler. `/submit` serves its page at the same host, with no body replay.
- Each agent keeps the existing explicit confirmations, owner-intent recovery and exact operation,
  invoice and plan identities. Gateway errors do not establish refusal or settlement. The single
  dispatch site and unresolved-operation blocking are unchanged.

## Before production authorization

1. Review this candidate and the separate [Treasury correction patch](treasury-showcase-correction.patch).
   That patch corrects the uncommitted proposal in ../treasury; it has not been applied there. Proto
   must never be deployed as Treasury's redirect alias. The integration candidate supersedes that
   proposal's domain-move instructions; do not execute both plans.
2. Pin the final reviewed source revision and build artifact. Run pnpm typecheck, pnpm test,
   pnpm evidence:check and relevant browser regressions. Record results separately from deployment.
3. Obtain explicit production authorization for this exact four-domain rollout. Required access:
   Railway service/domain/configuration/deployment permissions, DNS-zone write access, owner-controlled
   sessions for post-deployment read-only checks, and operator access for stopped-writer backups.
   Read-only Railway access was demonstrated; DNS write access and production actions were not tested.
4. Verify generated-domain sign-in for the retained standalone installations before removing their
   custom domains. This needs their separate owners' authorization and compatible host settings. Do not
   deploy this repository over their existing registries. If this cannot be established, do not move
   their domains; keep the candidate pending rather than stranding an owner workspace.
5. Check for an unattended run, freeze, unresolved operation, active CLI writer or attempted owner
   signature. Agree on a maintenance window and preserve schedule settings. Verify every executor's
   identity against its retained settings without logging credentials. The read-only identity comparison is recorded in the first-owner release document; it does not replace a maintenance-window inventory.

## Authorized rollout procedure

1. Privately record deployment IDs, image digests, volume IDs, domain attachments, DNS values and
   current settings for all four services. Back up with writers stopped, using
   [operations](../operations.md#executor-migration-and-state-preservation).
2. Preserve each entire volume, including settings files, SQLite databases and WAL/SHM files as
   appropriate to the stopped backup procedure; .ops/, .invoices/, .owner-intents/, .strategy/,
   .plans/, .evidence/, .inbox/, .agreements/, .notify/, .work-orders/, .hosted/, .treasuries/, .payables/,
   and every nested instance .env and .initialized marker. Preserve secrets privately. There is no
   record conversion in this candidate. Never restore old state over later accepted work.
3. Confirm the invoices generated endpoint is healthy and retains INVOICES_PUBLIC_HOST=invoices.multiagency.ai.
   Keep its executor, volume and grant in place. Confirm gateway-to-upstream connectivity and internal
   agreement authorization through read-only checks before opening intake.
4. Stage dao DASHBOARD_FILE=/app/deploy/shared-demos.json and **unset DASHBOARD_HOST**. Retain its
   existing SESSION_SECRET and agent settings. Use one replica, zero overlap, the existing volume and
   existing executor assignment. Deploy only after the prior writer is stopped. No live funds test.
5. Move treasury.multiagency.ai, payables.multiagency.ai and invoices.multiagency.ai custom-domain
   attachments to dao port 8080. Retain proto.multiagency.ai there. Apply exactly the DNS/verification
   records Railway returns; do not reuse an assumed CNAME. Check TLS and DNS convergence independently.
   The approved plan must account for the interval where an old image and new domain attachment coexist.
6. Read-only acceptance: three static public entries, the supplier intake entry, all three Proto idea links, unknown-host refusal, own-host
   challenges, independent sign-in, no signed-out private reads, permissions by agent, retained record
   links, invoice intake and its original work-order links, owner policy/grant identity, balances and
   unresolved/history records against the private baseline. Verify no duplicate executors and no
   unexpected schedule change. Steward is absent from navigation. Do not count an HTTP 200 as settlement.
7. Record deployed artifact and observed read-only results. Only a separate explicit authorization
   permits the agency's low-value DAO experiments; this rollout grants no such authorization.

## Rollback

Stop the changed gateway/executor before restoring its prior image and settings; never overlap
Treasury writers. Restore domain attachments and DNS from the private pre-rollout record and verify
TLS and each original signing host. Keep all four current volumes attached to their original services.
The payout executor need not move for either direction. Restore the standalone host settings only
when their original domains are back. Expect fresh dashboard sign-in after session-format changes.

If requests were accepted after rollout, preserve their records and reconcile unknown outcomes. Never
restore an older journal, discard a submission identity, retry an attempted owner signature, or treat
routing rollback as authorization for another payment. The lock remains single-host coordination,
not distributed fencing. Rollback changes routing and code, not financial history.

## Candidate verification

Validation on 2026-10-15 UTC: `pnpm typecheck`, `pnpm test` (734 passing),
`pnpm evidence:check`, and `pnpm build:web` passed. Five offline browser suites passed:
`demo-hosts`, `public-overview`, `walkthrough-entry`, `payments`, and `work-orders`.
The sibling correction patch passed `git apply --check` against the inspected Treasury tree and
26 gateway tests after applying it to a temporary copy. It has not been applied to that sibling.
These tests use local fixtures; they establish neither live provider enforcement nor settlement.

This candidate is not deployed. The observations
above describe the independently inspected running deployments, not this source tree. The inspection
also found no `.hosted` directory on dao; repeat that check immediately before rollout. If reservations
appear, verify their owners, area assignments and executor identities before rollout. Never discard their state.

The retained standalone generated domains observed in Railway are
`treasury-production-c98c.up.railway.app` and `payables-production.up.railway.app`.
Their current signing configuration still names their custom domains; generated-domain sign-in
is a rollout prerequisite, not an observed working fallback.

The HTTPS invoice proxy strips untrusted forwarding headers. The invoice backend may therefore
rate-limit gateway traffic together under the gateway’s upstream address. Confirm intake capacity
before opening the demo; this candidate does not claim per-payee network rate-limit isolation.

## Payment workflow ownership

Payables develops both ideas 01 and 03. Invoices is its supplier-facing domain, not a fourth product
or separate repository. The candidate serves the existing supplier page at the Invoices root,
preserves work-order query identities, and retains `/submit` as a page alias. Root page writes are
refused; existing API submissions are streamed once. Proto’s idea 03 link opens owner work orders
in Payables, with a separate supplier-entry link. This does not move the existing Railway executor
or its state; all attachment changes remain subject to explicit rollout authorization.

After the supplier-entry clarification, typecheck, the full 734-test offline suite, evidence
consistency and the frontend build passed again. The affected `demo-hosts` and `public-overview`
browser suites passed at mobile and desktop widths. The earlier payment and work-order browser
results apply to their unchanged workflow controls. No production behavior was changed or observed
by this routing correction.

## Shared infrastructure extension — candidate, not deployed

The candidate now supports new regular NEAR wallet owners and authorized Sputnik DAO members on
all configured owner entry points. `hostedAreas` restricts the payment hosts to Payables; Proto and
the agency Treasury workspace offer both areas. Initial agency agents keep their original assignments.
The standalone self-service registries are not imported, copied or restarted by this change.

Supplier links for new Payables instances use `https://invoices.multiagency.ai/i/<instance>/`.
Their HTTP handler runs in the same payout executor under its existing lease; identity is required
before intake becomes available. Session keys derive from the gateway secret, supplier host and
instance; cookie names and local draft keys are distinct. Preserve SESSION_SECRET to retain sessions;
rotating it invalidates sessions, not operation history. Legacy supplier links and cookies remain
with the original invoice executor. Scope-specific links are used for owner-created work orders.

Before production authorization, review the open-setup capacity (32 instances), API account quota,
shared-host resource limits and supplier rate limits. Test onboarding with offline fixtures; a live
owner signature, agent creation, grant, deposit or payment still requires separate authorization.
Read-only post-rollout checks can verify existing assignments and static entries; they cannot prove
new-owner money flows. Preserve all nested work-order state and `.hosted` settings in backups.
No record-format conversion or movement of the current Railway executors is required.

For a fresh infrastructure installation only, `deploy/multiagency.json` starts with no agency
agents or legacy invoice upstream. The supplier root asks for an owner-provided link and lists no
owners. Do not use this template to replace the populated `dao` configuration during this rollout.

Shared-infrastructure validation (2026-10-15 UTC): typecheck, the full 736-test offline suite,
frontend build and evidence consistency passed. The `demo-hosts`, `walkthrough-entry`, `invoices`,
`hosted-supplier` and `work-orders` browser suites passed. Real local child-process fixtures cover
wallet and DAO reservations, host-scoped access, restart reuse, unconfigured-intake refusal,
per-instance supplier sessions and forged cross-instance cookie reuse. Browser fixtures cover scoped
API paths, isolated draft storage and retention of exact submission identities without replay.
These are offline observations, not provider or mainnet demonstrations.

Owner-entry follow-up: `/workspace` shows **Your agents** for self-service installations, and each
agent has a task entry at `/a/<instance>/workspace`. Existing `/demo` and exact-record links remain.
Before rollout, verify wallet/DAO selection, both task types, and resuming a saved setup without a
second reservation. The candidate browser fixture covers these cases offline. Reverting this UI
restores the previous entry without changing `.hosted`, grants or operation records. Do not delete
reservations as part of UI rollback. Complete new-owner mainnet setup and operation remain a
separately authorized acceptance exercise, not a claim established by these fixtures.

Walkthrough-version follow-up: verify `/demos`, `/treasury`, `/payables`, `/invoices`, and their
agent-scoped short/complete destinations for both owner types. Ensure mismatched areas cannot
open action controls. Both lengths must retain explicit confirmation and exact-record outcomes.
AG-UI guidance is deterministic UI observation, not live model orchestration or execution evidence.
Roll back frontend assets and routes together; no state conversion, grant replacement, executor
restart or money action is authorized by this walkthrough preparation.

Walkthrough iteration validation (2026-10-15 UTC): typecheck, frontend build, 738 offline tests and
evidence consistency passed. Browser suites `walkthrough-entry`, `live-demo`, `demo-hosts` and
`work-orders` passed after updating route expectations. These cover short/complete guide entry,
wallet/DAO setup navigation, completed-agent workspace access, exact selected plan/payment guidance,
explicit confirmation, read failures and unresolved outcomes. No live signatures, provider execution,
deployment, service restart or state migration was performed.

## First-owner release gate

See [first-owner validation and release preparation](first-owner-release.md) for the continuous wallet/DAO journey, refreshed read-only baseline, configuration pins, backup gates and proposed bounded live walkthrough. Earlier verification counts above describe earlier snapshots; the immutable candidate result is authoritative for the release.
