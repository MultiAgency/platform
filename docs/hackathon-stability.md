# Hackathon stabilization record

Observed 2026-11-13 UTC. This record separates consumer compatibility from live feature activation.

The requested final release is [0.6.0](release-0.6.0.md). Issue #74 remains a release gate.
The owner deferred #81's provider dependency on 2026-11-13; keep its safe halt and explicit
consumer limitation, without claiming successful original-key recovery.

## Supported consumer baseline

Preserve the existing consumer SDK 0.5.9 archives and platform pin
`252cba1d1e6642a5ea9f42ea4927f982423ed8e1`. Do not repack changed sources under that
SDK identity. Follow [the handoff](hackathon-platform-handoff.md) for reproducible simulated
Treasury and Paperwork demonstrations and their acceptance limits. A new SDK requires a distinct
release identity and acceptance by both consumers before changing those pins.

## Repository and deployment observations

- GitHub queries returned no open PRs in Platform, Paperwork (`MultiAgency/demo`) or Treasury.
- Platform main `730e910807a27da94f3797e4f1da875e24a6dbfa` passed its verify and CodeQL workflows.
- Paperwork fix `33c48991b1c7ff5add40487dd5f16d8d41264ee4` passed verify and analysis checks.
  CI success does not establish deployment or live allocation validity.
- The reconciled staging package retained main's incoming-credit implementation and the local
  confirm-only frontend and Market allocation changes. Typecheck, evidence checks and 1,552
  offline tests passed. Its image check verified packaged files, two boots and unchanged test state.
- Staging deployment `2fd7d108-338a-4b12-b55b-892ccef16d8c` reported SUCCESS and healthy.
  Its installed manifest matched the reviewed package. A stopped-writer backup preserved all
  prior state files; the only changed prior file was the access audit, verified append-only.
  This is a working-tree package observation, not a claim that all its changes are merged on main.
- Market setup remained disabled. Existing holds and funding-only reservations were preserved.
  No hire, grant, funding allocation or payment was performed by that rollout.

## Remaining issues and release boundary

| Item | Disposition | Evidence needed to complete |
| --- | --- | --- |
| [Platform #74](https://github.com/MultiAgency/platform/issues/74) | Keep open; live Market activation remains gated | Exact route qualification, authority/external-writer review, legacy recovery and migration/rollback evidence |
| [Platform #81](https://github.com/MultiAgency/platform/issues/81) | Keep open; preserve unresolved original requests and block replacement sends | Authoritative original-request/key-to-operation binding and a lost-response recovery test without duplicate submission |
| [Provider SDK #38](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/issues/38) | Canonical inquiry; #37 closed as a duplicate, per the [release requirements](release-0.6.0.md) | Provider-supported read-only lookup, retention and negative-result semantics |
| Staging/main divergence | Release preparation remains necessary | Separate and review local changes, preserve incoming-credit support, and publish an exact tested source identity |
| Consumer acceptance | Retain established pins | Both projects accept any proposed replacement SDK/platform pairing using their actual integration checks |

Do not close evidence issues because CI is green. Do not activate Market, replay an unknown request,
clear a reservation or change credentials to make a demonstration pass. Simulated demonstration
acceptance does not establish live settlement. Existing consumer routes can remain usable while
these optional live features stay gated.
