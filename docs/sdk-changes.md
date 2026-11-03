# @multiagency/sdk changes

Every SDK change appends a note under the next version's heading when it is made: what changed for the apps, and any
wire change all apps must update for together. The first change after a release moves `package-version.ts` to the next
version, so a package staged or packed from changed sources never carries a released version's number. The release
candidate dates the heading. Under 0.x, any public-interface change bumps at least the minor version.

## 0.4.1

No code, type or wire change.

- **README and npm description**: both open with what the platform is, a control plane for agentic treasuries built
  on NEAR Intents; the description names the app-server client.
- **treasury-app**: where the limits are: the owner's policy, enforced by the provider on every path, in absolute
  amounts; no consent or credential has a budget of its own, and limits in an app's own process aren't a boundary.
- **getting-started**: the app row lists the `treasury` and `treasury-execute` scopes and when to ask for each; the
  machine row says it is reached through `ownerClient`, isn't extended, and is retired once Treasury moves to app
  access. Digests (`expectedPolicy`, `expectedDigest`) are read from the platform and passed back, never computed.
- **app-server**: how an app stops quickly: stop any autopilot it turned on first (revoking doesn't), revoke its
  consent, relay `agent_freeze`, and treat anything `executing`, `processing` or `unknown` as possibly sent.

## 0.4.0 (2026-11-02)

Additive: 0.3.x apps keep working, and a consent signed without the new scopes stays valid.

- **Treasury proposals** (`proposals/create`, `get`, `list`, `approve`, `reject`, `withdraw`, `execute`): an app proposes
  swaps under its own `requestId`; the owner approves the exact terms later by signing `proposalText(proposal, "approve")`
  (NEP-413, recipient the platform host); the app then asks for one execution, which re-quotes every swap and sends each
  with a floor at least the signed one, through the same plan execution as any saved plan. A proposal lasts at most 7
  days. New exports: `proposalCreateInput`, `proposalSigned`, `proposalRef`, `proposalView`, `proposalList`,
  `ProposalState`, `proposalText`, `tokenAmount`, `PROPOSAL_TOKENS`, `MAX_PROPOSAL_MS`, `MAX_OPEN_PROPOSALS`,
  `MAX_PROPOSAL_LEGS`.
- **Consent scopes `treasury` and `treasury-execute`** (`AppScope`, `APP_TREASURY`, `APP_TREASURY_EXECUTE`): `treasury`
  reaches Treasury reads, strategy settings, autopilot on and off, sweep and proposals; `treasury-execute`, only beside
  `treasury`, adds `rebalance`, `externalPlan` and `executePlan`, which run for an app only while the owner's live grant
  binds the plan's strategy.
- **`appClient(...).agent(...).stream`**: an app reads the stream procedures its consent covers (`sweep`, and with
  `treasury-execute` `rebalance` and `executePlan`), as `ownerClient.stream` does. `call` takes the other procedures.
- **Machine route (platform, not an SDK type):** `executePlan` through a Treasury machine credential (`tmc_`) now runs
  only while the owner's live grant binds the plan's strategy, as an app's does; under a plain `treasury` grant it is
  refused before anything is claimed. The owner signs the strategy-bound grant once per saved strategy. Clients of the
  machine route (the treasury app's helper) need that grant before upgrading the platform.
- **Plans:** a plan's `source` may be `proposal`, with its `proposalId`; such a plan runs only as its proposal.
- **Owner capability** `treasury-proposals-v1`.
- **treasury-app skill.**

## 0.3.1 (2026-10-31)

No code, type or wire change.

- **License: MIT** (copyright MultiAgency LLC).
- **README:** "What the platform does for your product": what the provider does, what the platform guarantees to an
  app and what the app still does, and what has run where for each client's routes.
- **app-server skill:** the platform's host serves only `/apps/v1` and the confirm page (no sign-in or owner page), and
  setup there is for Payables agents only. A vote the platform can't verify is refused before anything reaches the
  provider (`refused`, code `local_authorization_held`).

## Earlier versions

0.0.1 to 0.3.0: see the [changelog at sdk-v0.3.0](https://github.com/MultiAgency/platform/blob/sdk-v0.3.0/docs/sdk-changes.md).
