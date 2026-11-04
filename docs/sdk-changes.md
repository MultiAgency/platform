# @multiagency/sdk changes

Every SDK change appends a note under the next version's heading when it is made: what changed for the apps, and any
wire change all apps must update for together. The first change after a release moves `package-version.ts` to the next
version, so a package staged or packed from changed sources never carries a released version's number. The release
commit dates the heading, before its candidate runs; staging copies this file as it is. Under 0.x, any
public-interface change bumps at least the minor version.

## 0.5.0

- **DAO consent** (added; offline- and stack-tested, not on any host yet): a DAO-owned agent's consent is signed by the DAO's
  own vote. `app.daoConsents.file(message)` files the canonical consent text and answers the proposal a member files
  (`proposal`, or `proposalAndVote`); `app.daoConsents.state(id)` answers `pending` until the DAO's signature is found on
  chain, then the stored consent. A DAO's consent carries only `DAO_CONSENT_SCOPES` (`read`, `treasury`, and `treasury-execute` as
  the DAO's opt-in). Under it the app reads, saves strategy settings, sweeps, creates and executes proposals, and turns
  autopilot on and off; with `treasury-execute` it runs plans too. Autopilot and plans swap without a vote each time,
  only under the grant the DAO voted for the saved strategy, whose proposal says so. The app can't sign or submit owner
  actions itself. `appAgent` and `appConsentView` gain an optional
  `signer` (`wallet` or `dao`; absent means `wallet`).
- **DAO votes** (added; offline- and stack-tested): `app.daoVotes.file({ organization, agent, proposal, verdict })` files
  the DAO's vote on one of the app's Treasury proposals from the platform's own `proposalText`; `app.daoVotes.state(id)`
  answers `pending` until the DAO's signature is found, then relays it to `proposals/approve` or `reject` once and
  answers `relayed` with the proposal's state. Under a DAO consent with `treasury`, `owner/prepare` with `signer: "dao"`
  prepares `DAO_APP_ACTIONS` (the `treasury` grant, freeze, unfreeze): the app gets the proposal a member files, never an
  intent; the agent submits the DAO's signature once the vote passes, and the app follows `owner/status`. Those are
  provider intents that expire in minutes, so only a DAO whose vote passes within `expiresAt` completes them.
- **DAO setup** (added; offline- and stack-tested): `app.daoSetups.file(message)` files a DAO's setup text
  (`setupMessage` with the DAO as owner, area within `DAO_SETUP_AREAS`, at most 7 days) for its vote, refused (403)
  before anything is filed on a host that doesn't set up that area;
  `app.daoSetups.state(id)` answers `pending`, then `reserved` with the hosted agent and its setup consent. Under it the
  app asks only for `agent_create` with `signer: "dao"` and no owner (the DAO's derived account), a second vote that
  must pass within the intent's minutes; then it files the DAO's consent naming the new agent's ID.
- **Skills**: app-server gains "A DAO owner" (consent, setup and owner actions by DAO vote, members gated with
  `accessOf` and `mayCall`); treasury-app gains "A DAO-owned treasury" (proposal votes; the grant vote authorizes
  unattended swaps).
- **DAO stop** (added; no SDK change): a DAO stops its agent by its own vote, with no app. Anyone opens
  `https://<host>/confirm/dao/stop/<agent>`, which files the stop or shows the one open. Once the vote has passed,
  opening it again revokes every consent naming the agent ID, from every app, and turns its autopilot off. An app's
  calls then answer `forbidden`.
- **Voter check page** (added; no SDK change): each DAO request's proposal description links to
  `https://<host>/confirm/dao/<hash>`, a public page showing the exact text the DAO's key signs and its NEP-413 hash
  recomputed. Show members that link.
- **DAO roles** (added): `accessOf`, `groupOf`, `permits`, and the `DaoPolicy`, `DaoRole` and `Owner` types, the platform's
  own reading of Sputnik roles (moved from the gateway, unchanged). An app reads the DAO's `get_policy` and gates each
  member's calls with `mayCall(accessOf(account, owner), path)`: Group members only, `strategy/save` only for a member
  who may change the DAO's policy. The platform doesn't check members under a DAO's consent; the app does.

## 0.4.1 (2026-11-03)

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
