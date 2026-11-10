# Releasing a hosted agent (0.5.6 candidate)

Built and tested offline with simulated provider, chain and wallet evidence. No archive, restore or hosted release has
been observed on mainnet through this platform. Provider behaviour below is per Agent API skills at `ce381df`
(`references/owner-intents.md`, `references/errors.md`), not a deployed-version guarantee.

An app can release a wallet-owned Organization agent's hosted slot. The owner first freezes and archives it through
`owner/prepare` and `owner/submit`, signing each provider intent. The provider documents archive as reversible,
requiring freeze and refusing the archived agent's operations. `agent_delete` stays unavailable; DAO archive and release
remain future work. Archive alone keeps the reservation.

## Release

With a live `owner` consent, call `app.release(organization, agent, { allowBalance: false })`. The gateway checks the
wallet's current ownership and consent key, and asks the executor's internal `releaseCheck` to prepare release.
The executor owns both its owner-intent lock and money lock while checking the same provider agent is archived and
frozen, its policy and balance views name that agent's wallet, its journal has nothing unresolved or held, and no owner action is open or submitted. Missing or malformed
evidence refuses. Every listed public and confidential balance must be zero unless `allowBalance: true`. For a market
agent this also checks the payment key's native NEAR (including locked storage) and USDC. Other unsolicited assets on
that key are not enumerated; retain the key and inspect it before explicitly leaving funds behind.

A refusal returns `{ state: "refused", reason, balances }`; it writes no release marker. A successful check first writes
`RELEASED_AT` and `RELEASED_ARCHIVE` in the kept instance settings and turns autopilot off. Every later dispatch and
owner-action submission refuses `agent_released`, including from another process sharing those settings. The gateway
then writes a `releasing` entry to `.hosted/released.json`, removes the reservation from `apps.json`, revokes all stored
consents for that agent, stops only its child and restart loop, and records `released`. The app gets
`{ state: "released", agent, agentId, at, archiveCorrelationId }`. The archive correlation is null when there is no
local retained archive intent (for example an archive performed outside this executor); the current provider view is
still required. Authenticated calls to the released identity and RPC routes answer 410 `agent_released` within the
original deployment and Organization scope. `reservations` includes it with `released: true`.

No records, grant tokens or payment keys are deleted or moved. Release frees one of the host's 32 slots and the app
deployment's 16 slots; the latter is shared across that deployment's owners and Organizations.

## Recovery and restoration

A release in progress is retryable by its original deployment credential and Organization even after its consents
were revoked: the durable release record proves the already-authorized transition. A single-host lifecycle lock
serializes release and setup across processes; restore waits for release to finish. A crash before the registry update
leaves the executor marked and unable to send. A crash between registry writes leaves `released.json` authoritative.
A gateway restart does not start an agent recorded as releasing or released. Unknown child cleanup leaves release
unfinished. An access change between marking and registry update leaves the executor blocked; renewed owner consent
is required to finish. This is single-host coordination, not distributed fencing.

To restore, request a new platform-issued consent nonce and have the owner sign a new setup for the same deployment,
Organization, owner and area. Pre-release setup/consent signatures are refused. Re-reservation reuses the same name,
provider agent ID, settings and payment key, subject to current capacity. Release history remains retained and old
consents stay revoked. The setup consent cannot act on an already-created agent: the owner signs a fresh ordinary
consent naming that provider ID, then signs unfreeze and restore. Those owner actions are separate from hosting setup.

## State preservation and rollback

The additive records are `.hosted/released.json` and the release keys in each `.hosted/<name>.env`. No conversion of
existing state is required. With executors stopped, back up and preserve every directory in `docs/operations.md`, the
whole `.hosted/` registry and every instance settings file together. Never reconstruct a released agent with a new key.
After a completed release, the 0.5.5 registry reader ignores `released.json`, leaves the agent down because it is absent
from `apps.json`, and refuses a replacement over its retained settings. An interrupted release or restoration needs
completion or an explicit compatibility review before rollback: an earlier dispatcher does not understand the marker.
Market `x402` journal compatibility remains an additional rollback constraint (see `market.md`).

## Evidence and remaining observations

`test/agent-archive.test.ts`, `test/agent-release.test.ts`, `test/hosted-release.test.ts`, the supervisor tests and
`test/e2e/agent-release.spec.mjs` cover owner relaying, refusals, dispatch blocking, retained identity, consent termination,
stale setup replay, capacity, per-agent shutdown and restore. Registry crash tests kill real child processes after each
write. The compatibility fixture uses the 0.5.5 registry implementation from `2e7b1e6` with import paths adjusted only.
The end-to-end test uses real gateway and executor processes with simulated external systems; it is not mainnet evidence.
Before claiming deployed behaviour, the owner must record a staging archive, a refused send while archived, a hosted
release and restoration. Mainnet actions and deployments remain owner-run. Standard jobs, competitions and DAO release
are outside this change.

During re-reservation `RESTORE_REQUIRED=<provider agent ID>` replaces the release marker in the same atomic settings
write. Dispatch remains refused until this executor records a successful owner-signed `agent_restore`; a host slot alone
never authorizes a send, including the market key's locally signed last leg. Preserve this key with the release keys.
A provider restore performed outside this executor needs operator recovery; it does not silently clear this marker.
