# Coordinated credential rotation

Prepared 2026-10-16 UTC; not executed. The [release record](archive/proto-release-execution.md) reports a
diagnostic exposure. Inspect credential names and consumer relationships only in shared output.
Never print environment objects, secret values, cookies, signed payloads, credential-bearing URLs
or raw diagnostic logs. Do not paste replacements into commands, source control or this document.

## Names-only matrix

The saved dao variable baseline contains the first five names below. This is a consumer inventory,
not proof of exactly which values appeared in the transcript. Treat them as rotation candidates
until the owner privately confirms exposure. Volume settings, other services and local consumers
require separate private matching; no cross-service sharing was assumed or queried here.

| Credential | Known/potential consumers | Owner-controlled change and restart | Verification without secret output |
| --- | --- | --- | --- |
| `NEAR_INTENTS_AGENT_API_KEY` | dao; its configured/hosted children; invoices and standalone Treasury/Payables if sharing | Replace at issuer and every matching consumer; restart affected service/children | Existing-agent read succeeds under the same partner namespace; old key rejected. Do not switch API origin or create agents to test. |
| `FASTNEAR_API_KEY` | dao and its inherited children; other services if sharing | Replace at issuer and matching consumers; restart affected services | Existing chain/ownership read succeeds; old key invalidated. |
| `NEARAI_API_KEY` | dao/static children; standalone services if configured/shared | Replace at issuer; restart consumers | Issuer key status or supported read-only authentication check. Do not trigger a steward run or paid inference merely to test. |
| `SESSION_SECRET` | dao gateway; derived host and managed supplier sessions | Replace on dao; restart gateway and its children | Old synthetic/controlled session denied; fresh owner sign-in works on each affected host; private denials remain. Managed supplier sessions also require fresh sign-in. |
| `TELEGRAM_BOT_TOKEN` | dao/static notification workers; other installations if sharing | Revoke/replace through issuer; restart consumers | Read-only bot identity check or issuer verification; do not send a notification without authorization. |
| `INVOICES_SESSION_SECRET` | invoices; independent standalone supplier listeners if configured | Rotate only if exposed/shared; restart relevant listener service | Old supplier session denied; supplier completes normal sign-in. |
| `AGREEMENTS_SECRET` | invoices bridge and dao payout settings; other bridge clients if sharing | Replace both ends in one coordinated window, including persistent settings; restart invoices and dao payout consumer | Existing agreement/work-order reads succeed; old bridge authentication denied. No agreement response submitted. |
| `AGENT_GRANT_TOKEN`, `AGENT_GRANT_TOKEN_PENDING` | Per-agent persistent settings and/or invoices environment | If exposed, separately authorize owner-signed replacement and revocation; update the actual startup source; restart that consumer | Provider confirms new live grant and old revocation; no operation needed. Restart must not reload the old environment token. |
| `AGENT_OWNER_PRIVATE_KEY` or deployment credentials | Only if private incident review establishes exposure | Separate issuer/owner key-recovery procedure; do not treat as an ordinary environment rotation | Verify authority/revocation through the appropriate issuer without signing a test money action. |

`TELEGRAM_CHAT_ID`, hostnames and project/service IDs are configuration, not replacement credentials;
keep private identities out of the public incident record. Independent Treasury/Payables services
remain unchanged unless consumer matching establishes an affected credential. Do not restart them
merely because their frontend domains now route through dao.

## Owner-controlled procedure

1. Privately confirm exposure scope and each consumer, including persistent files overriding Railway
   variables, local processes and inactive deployments that could later be restored. Record names,
   owners and completion status only. Restrict the exposed transcript and existing backups; deleting
   a transcript is not revocation. If active misuse is suspected, the owner chooses immediate issuer
   revocation even if service becomes unavailable.
2. Agree on an explicit maintenance window. Inspect schedules, active writers, unresolved operations
   and attempted owner signatures. Preserve the current volume and all state directories listed in
   operations, including nested work orders and hosted registrations. Use stopped-writer backup and
   restore verification when maintenance touches persistent settings. Never overwrite current state
   with the prior release backup.
3. Confirm service IDs, current image identities, one replica, zero overlap, shutdown grace and rollback
   compatibility. dao retains Treasury execution and payout approve-only; invoices retains payout
   execution. Existing standalone executors keep their distinct identities and volumes.
4. The owner replaces affected credentials through issuer and Railway secret controls. Railway variable
   changes may automatically redeploy: stage with deployments suppressed where supported and reviewed,
   or perform the change only inside the approved stop/start sequence. Use private stdin/UI entry,
   not literal secret command arguments or diagnostic dumps. Prepare replacement before revocation
   only where the issuer supports it; otherwise plan an outage. Never leave an exposed credential
   valid merely to avoid coordinating consumers.
5. Stop affected writers and verify exit before replacement. Change both bridge endpoints together.
   Restart only affected services/children on their original volumes, using reviewed runtime bytes.
   This document does not authorize a rebuild, deploy, restart, grant issuance or revocation.
6. Verify health, fresh host-bound sign-in, authenticated reads and signed-out denial. Compare retained
   agent identities, executor assignments and record counts to the private baseline. Verify new
   credential authentication and old revocation without logging values. A read may refresh retained
   observations; it must not submit or retry business actions. Supplier sign-in needs supplier participation.
7. Record UTC time, service/deployment identities, changed credential names and pass/fail results.
   If verification fails, keep affected activity stopped and recover forward with valid credentials.
   An old image may be restored only with updated credentials and current compatible state. Do not
   restore exposed secrets, replay signatures or infer settlement from a successful restart.

Follow the near-agent-api skill (`.agents/skills/near-agent-api`). No values or private
evidence belong in tracked documentation. Rotation is an outstanding production gate, not completed
by the infrastructure code fixes.
