# @multiagency/sdk skill spec

Skills ship inside the package version they describe (package-only distribution). Each app's own `/skill.md`
links to them instead of copying schemas. Skills grant no authority.

## Inventory

| Skill | Domain | Task |
| --- | --- | --- |
| getting-started | access | Choose owner or payee client; identities and server enforcement; result kinds; supported surface |
| owner-workflows | owner | Owner reads, owner-signed actions, plan streams, recovery without resending |
| app-server | app | An app server's credential, owner consents, relayed owner actions, payout requests by requestId |
| payee-workflows | payee | Reports, lost-reply recovery by id, payment status, agent connections |

## Decisions

- Vocabulary: owner, member (DAO participant), payee (an account with an agreement); "contributor" in product copy. Wire capability ids stay `supplier-*-v1`.
- Treasury machine credentials are described in getting-started but not taught: the Treasury skill helper owns that workflow.
- Every example is an exported function taking a client, so the package verification can typecheck and run it.

## Coverage and batch history

- 2026-10-18, version 1.6.0, first batch: the three skills above. Checked by typechecking and running every example against the packed tarball in an isolated consumer (`scripts/verify-skills.mjs`), and by `intent validate` inside the packed package.
- 2026-10-18, version 0.0.1 (the 1.6.0 batch, renumbered when the package versioning reset): getting-started names the wire constants to compare against (`supplier-*-v1` capability ids, `PAYEE_ROLE`); examples unchanged.
- 2026-10-19, version 0.1.0: version only. The release's changes (shared payouts, required `approvedAmount`, retryable local refusals) are owner compensation procedures, which these skills don't cover; examples unchanged.
- 2026-10-20, version 0.2.0 (unreleased): payee-workflows gains the complete report workflow (fields, new and revised requests, draft and submission, retained identities, recovery that counts a request as changed only when its version passed the command's, states and payment statuses); owner-workflows gains the Treasury machine-route client and recovery for actions without a caller identity; getting-started lists supported exports per entry and which kinds prove nothing was sent. Checked as before, with each new example run against stand-ins.
- 2026-10-27, version 0.3.0 (unreleased): app-server relays votes on held payouts and shows the prepared vote's proven terms; owner actions come back as a NEP-413 intent or a platform confirm page link (`ownerAction` example).
- 2026-10-26, version 0.3.0 (unreleased): app-server added (appClient, consent texts, relayed owner actions, payout requests by `requestId` with recovery by state); getting-started gains the app deployment identity and `appClient`; the others are version only. Checked as before, with each new example run against stand-ins of the app routes.
- 2026-10-30, version 0.3.1 (unreleased): app-server states the platform host as headless (Payables setup only) and the `local_authorization_held` refusal of a vote it can't verify; the others are version only.
- Remaining: owner access outside a browser (beyond Treasury machine credentials) is not supported, so not covered; TanStack Query integration is app-owned and not covered.
