# Shared agent access contract

This is a local candidate in Proto, not a deployed service or mainnet observation. Proto owns the
credential store, host routing, owner consent and access management. Treasury supplies its planning
and execution handlers and its consuming skill. Installing a skill grants no authority.

## Owner access

`/a/<name>/access` is a shared workspace page. It loads `/gw/access-session`, a host-local signed-in
view of configured Treasury agents, independently of provider observations. Wallet owners match the
configured owner; DAO members need current onchain management permission to inspect or revoke existing
records. DAO members still cannot issue or use machine authority. That view
provides no signing or execution capabilities. It is not a fresh assertion of provider ownership.
On independently packaged product hosts, `/a/<name>/access` serves Proto's shared frontend;
content-hashed shared assets are available when absent from the product asset directory. Ordinary
product pages and existing product assets keep their own frontend. Host-local session checks and
payee routing remain unchanged.
The ordinary workspace still uses `/gw/me` and the existing dashboard authorization rules.

With the existing host-local owner session:

| Request | Result |
| --- | --- |
| `GET /gw/machine-credentials/<name>` | `{ credentials: [...] }`, metadata only, filtered to this host, configured owner and agent |
| `POST /gw/machine-credentials/<name>` | `{ credential, token }`, status 201; token returned once |
| `DELETE /gw/machine-credentials/<name>/<id>` | `{ revoked: true }`; repeated revocation is safe |

Issuance accepts `{ label, scopes, ttlSeconds }`. Labels are 1–80 trimmed characters; durations are
60–86400 seconds (default 3600); scopes are a nonempty, duplicate-free subset of `read`, `prepare`,
`execute-plan`, `sweep`. The UI defaults to read-only for one hour and requires a separate review.
The label is not proof of the calling agent's identity. Anyone holding the bearer secret can use it.

Management requires the signed-in account to equal the configured owner, or current DAO management
permission, and the agent to be assigned to the current host. Listing and revocation do not require a provider read. Issuance additionally
requires fresh chain evidence that the owner is not a DAO and a fresh provider-backed identity read
matching that owner. Missing, uncreated or replaced agents cannot acquire authority from a warmed
dashboard cache. A failed issuance ownership check returns 409; the UI keeps revocation reachable.
DAO members cannot delegate machine authority. No verified DAO approval mechanism is implemented.

Rotation creates a new credential through another explicit review, then revokes the old credential;
there is no renewal or automatic extension.

Lost issuance responses are ambiguous: inspect metadata, revoke inaccessible access, then explicitly
start another review. The UI does not retry issuance. Lost revocation responses are unconfirmed until
metadata is refreshed or revocation is retried. Secrets never enter query caches or browser storage.
Context changes and access denials clear private state and discard late responses. Copy failure keeps
the one-time field available for manual copy. Hiding or reloading cannot retrieve a secret again.

## Machine transport

Use `POST https://<issued-host>/machine/v1/a/<name>/rpc/<procedure>` with
`Authorization: Bearer <token>`, no cookies or Origin. The body and streamed responses use Proto's
pinned oRPC serialization (`@orpc/client` 2.0.0-beta.46, an SDK dependency; beta.44 clients are tested offline only, see
[SDK changes](sdk-changes.md)). Unknown procedures refuse
access. Machine credentials are not browser sessions and cannot authenticate dashboard RPC or
credential-management requests. `ownerClient` from `@multiagency/sdk` reaches this route with an
absolute base and a `fetch` that adds the bearer (SDK skill `owner-workflows`); the client adds no
credential of its own.

| Scope | Procedures |
| --- | --- |
| `read` | `instance`, `overview`, `policyHistory`, `strategy/get`, `autopilot/get`, `activity`, `unresolved`, `autopilot/evidence`, `autopilot/log`, `ledger`, `ledgerCsv` |
| `prepare` | `externalPlan` (chosen swaps → saved plan); `rebalance` (allocation-based stream) |
| `execute-plan` | `executePlan` with `{ planId }` (stream) |
| `sweep` | `sweep` (existing input and streamed result) |

Permissions are independent: preparation does not permit execution; execution does not permit sweep;
execution does not imply reads. There are no owner-signing, policy/grant mutation, scheduling, recovery,
payments or payee procedures in this interface. The machine allowlist also intersects the current
dashboard capability mapping. Executor assignments remain enforced by the existing agent server.

Each credential binds the actual provider agent ID returned by `ownerIdentity`, configured agent
name, owner, issuing account and host. Each call rechecks fresh ownership, then expiry and revocation
after receiving the body and completing identity lookup. Authorization, cookies and client-supplied
`x-gateway*` headers are removed before forwarding. Admission attribution records the credential ID,
account, owner, host, agent ID and procedure, without request bodies or bearer secrets. Required record
or audit failures refuse forwarding. There is a 600-request hourly limit per credential.

Execution still uses the existing saved-plan claim, fresh checks, money lock, journal and dispatch.
A forwarded request may already have acted when its response is lost. Inspect the original plan and
operation records before another action. Revocation does not cancel a forwarded operation, stop the
schedule, or prove settlement. Credential status describes local expiry/revocation, not current
ownership, provider readiness, policy validity or settlement.

Credentials have **no separate spending budget**. External clients executing saved plans are not
limited by the scheduled autopilot's per-run ceiling. Existing policy and grant checks still apply.
Spending caps do not bound market exposure; provider concurrency guarantees remain unverified.

## Treasury skill/client contract

Use this single shared contract and the host/name supplied at consent. Never fall back to browser
cookies, another host, or the experimental Treasury gateway. Store the token in the runtime's secret
store, not a skill file or chat. Keep read, prepare, execute and sweep commands distinct. Consume
streams fully and execute only an explicitly selected saved plan. Do not retry unknown execution
outcomes automatically. Treat 401/403 as refused access and 404/405 as unavailable support.

The Treasury skill's `prepare FILE` calls `externalPlan` with a strict `{ swaps }` object: one to
eight ordered swaps between managed USDC, wNEAR and ETH, differing `from`/`to` asset IDs, positive
atomic-unit `amount` strings (at most 40 digits), and optional `minAmountOut`. Proto quotes each swap;
a supplied floor can tighten but never lower the provider floor. Invalid inputs, forbidden outputs,
excessive cost, aggregate overspending, changed policy/strategy/balances, or required storage failure
refuse the complete preparation. Preparation moves no funds and never drops or replaces chosen swaps.

The response is one saved plan with `source: external`, a UUID, five-minute expiry, exact ordered
actions and policy/strategy/agent bindings. `executePlan({ planId })` requires independent
`execute-plan` scope and runs the existing guarded dispatch path, including fresh quotes, plan claim,
lock, journal, unresolved-operation refusal and provider policy/grants. External choices need not
follow allocation targets, but retain the owner's strategy digest and cost limit. Credentials add no
spending budget; the scheduled autopilot's per-run ceiling does not limit external plan execution.

The Treasury-owned `skills/treasury` helper and documentation use this shared contract. The helper
checks returned chosen inputs and floors, reports unavailable support on 404/405, and never retries or
substitutes streamed `rebalance`. An older host without `externalPlan` remains unavailable for chosen
swaps. No separate gateway, consent, MCP or OAuth interface is introduced.

## Agent connections (contractor reports)

A user can connect an external agent to their workspace with an explicit, fixed set of permitted actions, and list
or revoke it. One mechanism serves every role, each with its own principal and permission sets
(`src/agent-connections.ts`, `src/contract/agent-connection.ts`). No connection carries every permission its user
has. Treasury's execution delegation (machine credentials, above) is a separate mechanism and stays so.

The first permitted set is a contractor's own compensation reports (`compensation.read`, `compensation.submit`) on
one payee entry:
- **Issuance:** `POST /api/agent-connections` on the entry, with the contractor's signed-in browser session only (any
  Authorization header → 403); the account is re-checked immediately before issuing. The `tac_<id>.<secret>`
  token is shown once and stored hashed. Lifetime is one minute to 24 hours. `GET` lists and `DELETE` revokes the
  account's own connections on that entry.
- **Binding:** host, entry (instance), account and payout agent id. Anything else is 401.
- **Reach:** with a bearer, the cookie is never read. Only `GET`/`POST /api/compensation` and
  `GET /api/compensation/session` answer; every other route is 403 and causes no business effect. Sign-in and
  session routes refuse it, so it never opens or becomes a browser session. A report write re-checks the
  connection immediately before acting.
- **Attribution:** each bearer call is appended to `.agent-connections/access.jsonl` (account, host, entry, agent,
  connection id, method, path, and command identity for writes).
- **Client:** `payeeClient({ base, token })` from `@multiagency/sdk/payee` sends the bearer
  without cookies, for programs outside a browser.
- **Consequence:** anyone holding the token can read the contractor's own reports and payment states, and submit
  reports as that contractor on that entry, until it expires or is revoked. It cannot file invoices or orders,
  approve, pay, or reach another account, entry or host.

Offline-tested (`test/agent-connections.test.ts`) and shown on the local stack (`agent-connection.spec.mjs`:
report, lost reply recovered by reading the same request id, owner review and authorization, human filing,
recorded payment, revocation; mutation challenge `agent-route-unrestricted`). Not deployed; no live credentials.

## State preservation and rollback

`.machine-auth/` is additive host-local gateway state, owned by one gateway process. It contains
private version-2 JSON records (SHA-256 secret hashes, mode 0600, directory 0700) and admission audit
records. Existing version-1 experimental records remain listable and revocable but cannot authenticate;
there is no automatic authority upgrade. The directory is excluded from Git and both Docker contexts.

`.agent-connections/` is additive per-entry state in each payee entry's executor directory: private records
(SHA-256 secret hashes, mode 0600, directory 0700) and `access.jsonl`. No conversion is needed. Losing it ends every
agent connection on that entry (tokens are refused) and loses their attribution; restoring an older copy can
restore revoked connections, so preserve the latest. Preserve `.machine-auth/` alongside `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`,
`.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/`, and `.hosted/`. No conversion of
existing records is required. External plans add the `external` source value to new `.plans/` records;
existing plans, claims and all other state remain unchanged and use the same loader/executor.
Do not copy credentials between hosts or executors. Backups and restores
must preserve current revocations: restoring an older credential directory can restore revoked
authority. A code rollback must retain the latest directory; if that cannot be guaranteed, disable
machine routing until credentials have been explicitly revoked or expired. Distributed revocation or
fencing is not implemented. No deployment, production restart or live action is part of this change.

## Local acceptance

- `test/machine-auth.test.ts`: persistence, secret hashing, expiry, revocation, legacy refusal and scopes.
- `test/machine-authority.test.ts`: fresh evidence despite a warm dashboard cache; missing identity refusal.
- `test/machine-routes.test.ts`: scope and identity binding, body/lookup revocation race, sanitized forwarding,
  provider-outage management, and refusal on audit-storage failure.
- `test/machine-hosts.test.ts`: real shared gateway host/session/agent isolation and DAO refusal.
- `test/browser/agent-access.cjs`: desktop/light and mobile/dark, defaults, explicit review, focus,
  copy failure, one-time secrets, ambiguous outcomes, denial redaction and late issuance after navigation.
- `test/e2e/agent-access.spec.mjs`: real shared gateway and executor with a simulated provider and wallet;
  consent, exact chosen-swap preparation/execution with autopilot ceiling zero, duplicate refusal and
  provider-outage revocation after reload. With `--treasury-skill PATH`, uses the actual snapshotted helper.
- `test/external-plan.test.ts`: input validation, ordered choices/floors, whole-plan rejection, policy and
  balance races, stale valuation and storage failure without sends.
- `test/e2e/treasury-client.spec.mjs`: actual helper rejects changed/empty preparation, unavailable support
  and transport failure, without retry/fallback or secret/error-detail leakage.
- `test/e2e/treasury-interruption.spec.mjs`: real helper child process, shared gateway/executor and
  simulated provider. Losing either the first swap response or the second after a confirmed first
  success leaves one unresolved operation and blocks replay and
  replacement sends. Killing the helper after its first success does not duplicate submissions;
  the admitted server execution can continue after the client dies. Client disconnection is not
  cancellation, and absence of a client receipt is not proof that nothing moved.

Reproduce the consumer flow with `node test/e2e/run.mjs --treasury-skill
/absolute/path/to/treasury/skills/treasury agent-access.spec.mjs treasury-client.spec.mjs treasury-interruption.spec.mjs` (one shell
command). The manifest records the consumer snapshot hash; ordinary runs do not assume a sibling checkout.

These tests do not establish live provider behavior, distributed safety, screen-reader usability with
assistive hardware, or real-provider crash/settlement behavior. Client crash and response-loss cases
are simulated-provider acceptance only; executor/host termination at every dispatch boundary is not
established by these consumer tests. Existing mainnet claims and generated evidence tables are unchanged.

## Release review (not deployed)

1. Review the Proto and Treasury skill/client diffs together, preserving other sessions' edits.
   Retain the acceptance manifest and its exact source, client and dependency hashes.
2. Before a user-controlled release, confirm executor assignments and host registries and preserve
   all state listed above, especially current credential revocations and plan execution claims.
3. Release compatible gateway and agent procedures together. An older agent without `externalPlan`
   must remain unavailable for chosen swaps; no rebalance or experimental-gateway fallback is allowed.
4. After the user's deployment, begin with read-only checks. Live credential issuance, owner signing
   and funded execution require separate explicit authorization.
5. On rollback, preserve current state and never restore old revocations or unclaimed copies of
   executed plans. If compatible state cannot be retained, disable machine routing until addressed.
   A rollback or disconnected client does not cancel an admitted operation: inspect its journal and
   unresolved outcomes before any subsequent money action.
