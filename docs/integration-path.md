# Building a new prototype on Proto

How a team adds a prototype that reuses Proto's identity, access, records and guarded execution
instead of copying them. The worked example is `examples/minimal-prototype/`: one page, no build
step, no server of its own. Product walkthroughs live in their own repositories; this page covers
the platform only. Which existing workflows already reuse each piece is in [the reuse map](reuse-map.md).

## Who owns what

| Proto provides | The prototype owns | Out of scope for a prototype |
| --- | --- | --- |
| Host-bound wallet sign-in and a host-local session (`/gw/challenge`, `/gw/session`, `/gw/me`) | Its UI, copy and navigation | A gateway, executor, grant token or provider credential of its own |
| Per-agent, per-procedure authorization on every call to `/a/<agent>/rpc/<procedure>` | Non-authoritative drafts and preferences (browser storage) | Authoritative payment, treasury or owner-intent records |
| Owner intents: prepare, wallet signature, single submission, durable status | Which owner actions it offers, and its explanation of each | Signing on the owner's behalf, or treating approval as settlement |
| One send site (`dispatch`), unresolved-operation blocking, reconciliation | Its release, rollback and asset retention | Callbacks into Proto (none exist; a demonstrated need comes first) |
| Agent registry, executor assignment and host routing (`dashboard.json`) | Its `contract.json` declaring what it needs | Choosing hosts or agents from a request |
| The isolated stack and simulator for local proof | Its own tests and recipes | Live funds, credentials or production state |

## How the dashboard connects (decision, issue #3)

The dashboard (`dev.multiagency.ai`) is a separate origin and reaches the gateway through the **machine interface**:
bearer credentials (`/gw/machine-credentials/<agent>`, then `POST /machine/v1/a/<agent>/rpc/<procedure>`; see
[agent access](agent-access.md)), called from the dashboard's **server**. It is not a new host kind and it is not
embedded behind an existing host. The `read` scope includes `summary`, the one call that returns balances,
budget headroom, held payouts and unresolved operations.

- Cookies are never shared across origins and CORS is not relaxed: a request with an `Origin` or `Cookie` header
  is refused on `/machine/`, so a browser cannot use a credential. `test/machine-routes.test.ts` covers the
  dashboard origin refused and the bearer call allowed.
- The owner issues the credential with wallet sign-in on the host, with a label, scopes and a lifetime of up to 24 hours.
- Limit: only a wallet-owned agent can issue machine credentials. A Sputnik-DAO-owned agent cannot yet, because no
  verified DAO approval for delegation is implemented ([agent access](agent-access.md)). The dashboard's
  DAO treasury needs that before this path serves it.

## Steps

1. **Choose a host and the agents it may reach.** A host entry in `dashboard.json` names its
   `demo` value, its agents and, for an independent build, `frontendDist`. Today `demo` is a fixed
   enum (`showcase`, `payables`, `treasury`, `invoices`) and agents have area `payables` or
   `treasury`. The example uses the existing `showcase` value with the `payout` agent. A new area
   needs a reviewed config change in Proto; ask before adding one.
2. **Declare capabilities.** Ship a `contract.json` with `version`, `product` and `required`
   capabilities. For payee frontends the gateway checks it before serving HTML
   (`src/payee-contract.ts`). For owner-app hosts (`frontendDist`) nothing checks it yet:
   that is P2. The example's capability names are provisional until P2 defines owner-app capabilities.
3. **Depend on the contract package** for any route it defines (`src/contract/`, packed as
   `@multiagency/sdk`). It has the payee schemas, compensation schemas and a typed
   client that never mints identities and keeps 401, 403, refusals and unknown outcomes distinct.
   From 1.3.0 it also has the owner contract: `ownerClient`, `OwnerInputs` and published output schemas for the
   owner procedures Treasury and Payables use (reads, mutations and the four streams). Recovery is decided by
   `kind`, never by message text: `session`, `forbidden`, `unresolved`, `busy`, `refused`, `provider`, `unavailable`
   (a read; safe to repeat) and `unknown` (a mutation or stream that may have taken effect; keep its identity, never resend).
   1.3.1 adds the platform definitions Proto itself uses, so apps import rather than copy them: the
   procedure→permission map (`mayCall`, `Access`; presentation only, the gateway still authorizes), `ASSETS`,
   intents-account normalization, the `/gw/proposals` schema, the strict run-recording and run-progress schemas,
   provider refusal details on `provider` failures, an optional `{ signal }` per call, and a server-computed
   `progress` on `workOrders/get`. Valuation and budget-window helpers stay app-owned.
   1.3.2 types the policy `schedule` as the provider SDK's own shape (mode, time zone, day windows).
   1.4.0 starts the owner contract (`ownerContract`, `@orpc/contract`): the Treasury plan workflow (overview, activity,
   unresolved, strategy/get, owner/{prepare,submit,status}, rebalance, executePlan) with its inputs and typed errors,
   which Proto's server implements and `ownerClient` is typed from. It moves to oRPC 2.0.0-beta.44 and zod ^4.6.7.
   A provider failure after a mutation that does not prove nothing executed is now `unknown` with identity, not `provider`.
   Payee-only apps import the `/payee` entry, which needs zod alone.
   1.4.1 fixes the shared release server's `stage` for read-only builds on Node 24 (the staged copy is made owner-writable).
   1.5.0 adds agent connections for payees: `payeeClient({ base, token })` for a contractor's agent outside a
   browser, `agentConnections`/`startAgentConnection`/`revokeAgentConnection`, and their schemas (see [agent access](agent-access.md)).
   1.6.0 is the same API under the name `@multiagency/sdk`, with the payee entry at `/payee` and `/release-server` unchanged.
   **0.0.1** restarts the package's numbering; apps pin by path and sha256. It is 1.6.0's content. Wire values may change
   with all apps updating together: an agent connection's `role` is `"payee"` (`PAYEE_ROLE`), which 1.5.0 clients
   (Invoices G and earlier) reject, so those releases are not rollback targets across it; hosted contributor sessions
   signed before it end once. Under 0.x, any public-interface change bumps at least the minor version (0.0.x → 0.1.0).
   What changed in each version, and what the apps must do: [SDK changes](sdk-changes.md), shipped in the package as `CHANGES.md`.
   **Development** links the SDK instead of a tarball: in Proto, `pnpm sdk:dev` stages `packages/sdk` and keeps its
   `dist`, skills and change notes current (`--once` stages without watching); an app depends on
   `"@multiagency/sdk": "link:/Users/jlwaugh/agencies/dao/proto/packages/sdk"`. Each release candidate pins one packed
   tarball instead (`pnpm contract:pack`, by path and sha256), and the full E2E runs against it.
   It ships its agent guidance as TanStack Intent skills (`getting-started`, `owner-workflows`, `payee-workflows`): in an app
   that installs the tarball, `npx @tanstack/intent@0.5.5 list` finds them and `npx @tanstack/intent@0.5.5 load
   @multiagency/sdk#getting-started` prints one. `pnpm contract:skills` checks the packed tarball offline: every example
   typechecked in an isolated consumer and run against stand-in servers, `intent validate`, `list` and `load`.
   The example calls the few procedures it needs directly.
4. **Call only through the gateway, same-origin.** Sign in with `/gw/challenge` → wallet
   `signMessage` → `/gw/session`. Read and act through `/a/<agent>/rpc/<procedure>` with body
   `{"json": input}`. A 401 means sign in; a 403 means this account may not see the agent or call
   the procedure. A 403 is not proof that the session expired.
5. **Keep human signing.** Owner actions are `owner/prepare` → show `preview.summary` → the wallet
   signs `intent.payload` (NEP-413) → `owner/submit` once → follow `owner/status` for the same
   `correlationId`. Never sign again after a lost response; read the existing record.
6. **Release independently.** Follow the Invoices asset-service convention
   ([invoices-extraction.md](invoices-extraction.md)): an immutable built artifact that serves only
   public assets, keeps old hashed assets during rollout, and rolls back without touching backend
   records. An owner app can be served by the shared release server (`frontend` host config): the gateway
   checks each release's `contract.json` capabilities, refuses an incompatible release (503, records
   unchanged) and binds the served page to the checked release. A legacy host still serves a directory
   (`frontendDist`). Offline E2E only (`owner-release`, `treasury-release`, `treasury-migration` specs); not deployed.
7. **Test on the stack.** From Proto: `pnpm test:e2e:stack --frontend examples/minimal-prototype`
   (a repository directory, or your build's absolute path) starts the real gateway, agent servers
   and simulated provider, with owner and payee wallet contexts. See [testing.md](testing.md).
   Write the prototype's own end-to-end check like `test/e2e/minimal-prototype.spec.mjs`.

## The worked example

`examples/minimal-prototype/` signs in through the gateway, reads `overview` for the `payout`
agent, and pauses or resumes the agent with an owner-signed `agent_freeze`/`agent_unfreeze` intent.
It contains no gateway, executor, credential or callback code. `test/e2e/minimal-prototype.spec.mjs`
runs it on the real gateway: owner sign-in, scoped read, two wallet signatures and two provider
submissions, with signed-out scoped calls refused (401) and no transfers. Signatures come from the
unfunded fixture key. Freeze/unfreeze outcomes come from the simulator, not an observed provider.

## Gaps

- Host `demo` and agent `area` are fixed enums; a new prototype reuses an existing value or needs a Proto config change.
- Owner procedures outside the Treasury/Payables set (for example `ownerIdentity`, `demoGuide/compose`) have no packaged contract.
- Independent owner-app releases are proven on the local stack only; no deployed host uses the `frontend` release origin yet.
- No app-callback channel exists. Any server-side need is reviewed first (P1 item 3).
- The example is offline-tested only; it has not been deployed or observed on mainnet.
