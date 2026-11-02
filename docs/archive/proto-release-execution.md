# Proto rollout — 2026-10-16 UTC

Rollout executed under the owner's authorization of `proto-release-review.md`.
The application release, three domain attachment moves, owner-host sign-in and
private-access checks succeeded. DNS alignment has been verified after the owner
saved all three CNAME updates. No agent, grant or money action was submitted.

## Released

Dao deployment `09bf2aa6-d805-400a-97a8-7e55b7f131fa` reached SUCCESS.
Railway image: `sha256:95ceea0c37486922c2946f6a39fc5e5528af8c7c0132dd16e8fcdf2bb3a8d4d8`.
All 195 packaged runtime hashes matched the frozen r2 manifest after deployment.

Note (2026-10-19): a read-only Railway check by the owner shows `09bf2aa6` REMOVED. dao's active deployment is
`0c1f8239-497b-4987-a495-8bb8e96051e6` (2026-10-16T05:08Z), which no release record names. Its contents are unverified.
Effective controls: root Dockerfile, one replica, zero overlap, `/health`,
ON_FAILURE with five retries. Original dao volume and private settings were preserved.
The final status check observed exactly one active deployment and one running
instance for each of dao, invoices, Treasury and Payables. The three unchanged
services retain their previous deployment IDs. All three owner hosts returned
200 for health and 401 for signed-out scoped private reads.

The owner confirmed external writers stopped. The previous deployment was verified
stopped before maintenance startup; the maintenance deployment was verified stopped
before r2 startup. A whole-volume archive and isolated, network-disabled restore
passed for 40 filesystem entries and two SQLite databases, including numeric owners,
modes, links, ACLs and extended attributes. A database byte change on shutdown was
checked against the pre-stop capture: logical records in both databases matched.

Proto owner-controlled wallet sign-in passed. Read-only POST RPC calls returned the
existing Treasury executor and approve-only payout assignment, eight retained owner
records each, and no unresolved operations. Signed-out private access returned 401.
Direct GET attempts at the RPC procedures returned 404; these procedures use POST
transport even for reads. That diagnostic result was not an authentication failure.

## Routing state

Treasury's custom domain is attached to dao, port 8080. Railway reports ACTIVE,
verified ownership and a valid certificate. Public HTTPS matches the packaged
Treasury frontend and its challenge recipient is treasury.multiagency.ai.
New-host owner-controlled sign-in passed, as did private instance reads for both
assigned agents and opening the existing Treasury dashboard. Setup discovery
advertises the configured Treasury and Payables areas; no reservation was created.

The registrar initially twice rejected saving the replacement CNAME. At that point
the record remained `w6oreib2.up.railway.app` while Railway required `kmwjm2ee.up.railway.app`.
The working route during that interval was a temporary migration state, not evidence
that the old target was permanently supported. The owner later completed the DNS
updates documented below; no DNS record was changed directly by this session.

After the owner requested another way around the registrar failure, the remaining
authorized attachments were moved using the same temporary migration approach.
Payables and Invoices now attach to dao port 8080. All three report ACTIVE,
ownership verified and valid certificates. Normal HTTPS verification passes.
Payables had a brief certificate hostname mismatch during edge propagation; the
follow-up passed without disabling certificate validation. Their original
executors and volumes were not restarted or moved. Treasury's previously accepted
generated-host browser session remains authenticated with its existing agent;
Payables' generated-host session remains authenticated with an empty workspace.
The invoice upstream root page and health endpoint returned 200; `/submit` is a
gateway alias and is not an upstream page route. Through the new shared route,
supplier `/` and `/submit` both return the exact upstream page bytes, and the
POST `/api/signin/challenge` response names invoices.multiagency.ai.

Final CNAME alignment: the owner subsequently saved all three updates. A fresh
lookup through 1.1.1.1 returned each required target below; HTTPS returned 200 on
all three hosts, with both independent frontend entry files matching the frozen
package. All three published verification TXT values also match Railway's current
requirements. The earlier registrar error is resolved.

| Host | Previous target | Verified current target |
| --- | --- | --- |
| treasury | w6oreib2.up.railway.app | kmwjm2ee.up.railway.app |
| payables | 8n0n1ucv.up.railway.app | ss7lnbmz.up.railway.app |
| invoices | qz4aewsf.up.railway.app | y73v00g2.up.railway.app |

Railway staff's [migration guidance](https://station.railway.com/questions/migrate-custom-domain-from-a-service-to-c35d5b86)
describes retaining the old CNAME while changing attachments, then updating DNS.
That final DNS step is now complete; the temporary old-CNAME state is no longer used.

## Evidence and remaining work

Private evidence is under `.test-artifacts/proto-maintenance-20261016/`, including
the stopped-volume archive, restore log, state/configuration baselines, deployed
hash verification and execution-result.json. Do not commit this directory.

Payables subsequently passed owner-controlled sign-in and authenticated navigation
to the existing payout dashboard. Discovery exposes only payout and setupAreas
`["payables"]`; private instance and owner-record reads returned 200, executor=false,
eight retained owner records and zero unresolved operations. Payments and Agreements
rendered; Agreements' “Open invoice page” link points exactly to
`https://invoices.multiagency.ai/submit`.

The existing payout returned zero work orders. A live exact-record supplier journey
and supplier-wallet sign-in were not established. Preserve this coverage limit;
no agent or work order was created to manufacture evidence. The frozen offline
supplier journey passed, including exact IDs and reload; hosted supplier page,
alias, challenge and discovery routing passed separately. No money action occurred.

One configuration diagnostic accidentally printed secret values into the tool
transcript. They were not repeated in this document or rotated during rollout.
A coordinated credential rotation remains required separately from routing work.

Recovery target remains dao deployment `f3c78026-3826-4380-a94a-9947277b38fa`;
eligibility was verified before stopping it. Refresh eligibility before any recovery.
Keep current volumes and post-release records; never overwrite them with the backup.
No code rollback has been performed. Domain restoration, if needed, must verify
provider-returned DNS/TLS and original standalone access rather than assume the old
attachment identifiers can be reused.

Skills used: use-railway, agent-browser and signed-in-browser-checks.
