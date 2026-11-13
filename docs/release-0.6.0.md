# Platform and SDK 0.6.0 release requirements

Requested 2026-11-13. This is a release target, not a published version or completion claim.
[Market qualification #74](https://github.com/MultiAgency/platform/issues/74) remains a release
requirement. On 2026-11-13 the owner deferred the provider dependency for
[lost-response recovery #81](https://github.com/MultiAgency/platform/issues/81): keep the issue open,
retain unknown requests and block replay. Successful original-key recovery is not claimed by 0.6.0.

## Required completion evidence

| Gate | Acceptance |
| --- | --- |
| Market deployed route | Exact recipient, asset and amount proven by final destination receipts and later final chain views; retain sensitive identities privately |
| Market authority | Reviewed executor, credential, grant and payment-key holders across actual environments and external writers; record single-host locking limits |
| Legacy Market funding | Every in-scope unbound top-up and residual has a supported disposition, with unexplained or unresolved funds held; no blanket clearance or replacement-key workaround |
| Preservation and compatibility | Isolated restore from the preserved state, complete directory/settings/key preservation, and tests showing older readers refuse incompatible journals |
| Deferred provider original-operation identity (#81) | Future closure requires authoritative read-only binding, retention and negative-result semantics; not a 0.6.0 completion claim |
| Lost-response safety in 0.6.0 | Preserve the original unknown request across restart, block replacement sends and retain committed budget; distinguish this safe halt from successful recovery after the operation ID is retained |
| Consumer acceptance | Treasury and Paperwork validate the exact new SDK/platform pair using their integration and restart checks; preserve historical 0.5.9 artifacts unchanged |
| Release reproducibility | Reviewed source commit, distinct 0.6.0 artifact identity and checksums, complete provenance, required repository/consumer checks, and packaged-image validation |

The remaining provider contract is tracked in canonical
[provider #38](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/issues/38);
#37 was closed as a duplicate after its additional requirements were copied to #38.
At the 2026-11-13 inspection, neither inquiry had a provider response and neither inspected live OpenAPI
specification documented a GET lookup by original idempotency key. That is an external dependency,
not permission to substitute mutation replay or heuristic matching.

## Delivery sequence

1. Reconcile and review the exact source already deployed to staging; preserve incoming-credit support.
2. Finish the authority/legacy inventory and isolated preservation/restore/rollback checks for #74.
3. Retain and verify the lost-response safe halt for both consumers. Defer implementing #81's lookup
   until the provider contract is available. Money-path edits require confirming the active-run/freeze window first.
4. Build a distinctly identified candidate, run typecheck, offline tests, evidence checks, applicable
   browser/stack/image checks, and both consumers' acceptance checks against the same bytes.
5. Close #74 only when its evidence is complete; keep #81 open as a known recovery limitation.
   Publish final 0.6.0 through the separately authorized release process. Do not relabel existing 0.5.9 archives.

The policy increase, fresh grant and one exact Market hire remain a separate owner signing flow.
Release planning alone authorizes no signature, funding, payment, credential rotation or hold change.
