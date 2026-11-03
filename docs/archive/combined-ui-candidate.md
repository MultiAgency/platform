# Combined UI, strategy and recovery candidate

Archived from [operations](../operations.md): the parts specific to this candidate. Its rollout and verification
steps stay in [operations](../operations.md#releasing-to-both-services).

This is the locally prepared candidate based on `5cd6cc9fbb584a3174b6d7586fbdda8633cf4d45`,
not a deployment record. The base commit alone does not identify its uncommitted changes: retain
the reviewed file-hash manifest and the final release commit or source-archive checksum in the
private release record. Recheck changes made after validation before shipping. Local browser
fixtures and offline tests do not establish hosted behavior or actual screen-reader speech.

## What ships where

| Service | Candidate changes | Persistent state |
|---|---|---|
| `dao` (`Dockerfile.gateway`, packaged) | Dashboard simplification; reviewed policy/payment confirmations; strategy save, authorization and enable controls; payment/owner-action recovery views; private AG-UI recording inspector/export. Treasury executes here; payout remains approve-only. | Existing `/data/state`, including both agents' settings and this host's owner intents |
| `invoices` (`Dockerfile.payouts`) | Invoice agreements precede amount fields; stable focus during refresh; continuation of unchanged, never-submitted invoices; shared payout/backend changes. Payout executes here. | Existing `/data`, including invoice SQLite, agreements and payout settings |

Invoice refreshes display only the latest requested read. Superseded responses cannot restore old
invoice controls or clear a newer read failure (`test/browser/invoices.cjs`, offline fixtures).

The subsequent [live run view](../live-run.md) integrates automatic AG-UI snapshot refresh into recent run timelines in the
dashboard, using the existing private recording endpoint. It introduces no stream endpoint or
state migration. The shared FastNear helper now reports read failures explicitly and rejects
malformed JSON; ship that correction to both services with the same reviewed candidate.

The recording adapter now exports envelope version 3 with AG-UI protocol 1.0 lifecycle validation.
The dashboard continues to read archived versions 1/2. Exports are derived from existing records;
this envelope change needs no stored-record conversion and adds no directory. Preserve the run
progress and evidence stores described below. Verify the reader and exporter together from the
same candidate; this compatibility is offline-tested, not a deployed-host observation.

## Compatibility and state

- Dashboard `pay` and `owner/prepare` policy updates now require `expectedPolicy` (revision and
  mandate digest). Old requests without it fail validation before provider reads. A changed review
  is refused; reload the page and review again rather than replaying the old request.
- Treasury grant preparation requires the saved `expectedStrategyDigest` and the schedule off.
  New `strategy/get`, `strategy/save`, `autopilot/enable` and `autopilot/stop` routes support the
  workflow. Legacy `autopilot/set` can stop unchanged settings without a digest, but refuses
  unreviewed changes/enablement and combined change-and-enable requests. A stale settings form
  may therefore fail even when its button says Turn off: refresh and use the new stop control.
- `owner/actions`, `paymentHistory` and `autopilot/log` are private member reads. Strategy writes
  require settings permission; enabling scheduling requires execution permission. Approve-only instances refuse strategy changes
  and recording export. Owner-action history is local to its instance; payout discovery is bounded
  to 250 provider records from the past day and reports incomplete scans. Missing reads are not
  proof that no payout or owner action exists.
- `POST /api/invoices/:id/continue` uses the authenticated payee's stored terms and identity.
  It refuses revised or submission-attempted invoices; it is not a retry for unknown outcomes.
  The `/internal/agreements` contract is unchanged. Old/new mixed builds are not a validated
  operating configuration; keep activity paused until both services are upgraded.
- No SQLite, journal, owner-intent or strategy schema changes are introduced relative to this
  candidate's base. The invoice SQLite and journal-v2 migrations below already exist in that base
  (and in recorded source `9b2941a`). Do not rerun migration or initialize empty stores merely
  because this release adds recovery views. If the actual deployed source/state is older or
  unknown, establish compatibility and apply the relevant stopped-writer procedure first.
- Strategy controls add a transient single-host control lock beside the existing strategy file;
  strategy saves persist schedule-off before replacement. This is not distributed fencing.
  AG-UI exports read existing evidence/journal files and add no durable recording store.
