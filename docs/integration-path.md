# Building a new prototype on Proto

How a team adds a prototype that reuses Proto's identity, access, records and guarded execution
instead of copying them. The worked example is `examples/minimal-prototype/`: one page built
with the SDK, no server of its own. Product walkthroughs live in their own repositories; this page covers
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

## Steps

1. **Choose a host and the agents it may reach.** A host entry in `dashboard.json` names its
   `demo` value, its agents and, for an independent build, `frontendDist`. Today `demo` is a fixed
   enum (`showcase`, `payables`, `treasury`, `invoices`) and agents have area `payables` or
   `treasury`. The example uses the existing `showcase` value with the `payout` agent. A new area
   needs a reviewed config change in Proto; ask before adding one.
2. **Declare capabilities.** Ship a `contract.json` with `version`, `product` and `required`
   capabilities (`ownerCapabilities` and `payeeContract` in the SDK name them). For a host served by the shared
   release server (`frontend` host config) and for payee frontends, the gateway checks it before serving HTML and
   refuses an incompatible release. A legacy `frontendDist` directory, like the example's, is not checked.
3. **Use `@multiagency/sdk`** for every route it covers, rather than the RPC wire format. Start with the package
   README (`src/contract/README.md`, shipped as the package's `README.md`): how to install it, which client fits which
   caller and access, and first reads. Its bundled skills (`getting-started`, `owner-workflows`, `payee-workflows`)
   carry complete, verified examples. Install it from npm (`pnpm add @multiagency/sdk zod@4.6.7`; the owner entry brings
   its own oRPC and AG-UI), or link an SDK
   repository checkout for development against unreleased source (`pnpm sdk:dev --once` in the SDK repository, then
   `"@multiagency/sdk": "link:../sdk/packages/sdk"`). A linked checkout can differ from the published package of the
   same version; record which one each release was built with.
   What changed in each version, and what apps must do: [SDK changes](sdk-changes.md), shipped as `CHANGES.md`.
4. **Call only through the gateway, same-origin.** Sign in with `/gw/challenge` → wallet `signMessage` →
   `/gw/session`; read the account from `/gw/me` with `gatewayDiscovery`. Read and act with
   `ownerClient({ base: "/a/<agent>" })`: each result is `{ ok: true, value }` or a failure `kind`. `session` means
   sign in, `forbidden` means this account may not see the agent or call the procedure (not that the session expired),
   `unavailable` is a read that is safe to repeat, and `unknown` is an action that may have taken effect.
5. **Keep human signing, and keep the action's identity.** Owner actions are `owner/prepare` → keep the returned
   `correlationId` durably → show `preview.summary` → the wallet signs `intent.payload` (NEP-413) → `owner/submit`
   once → follow the record for the same `correlationId` (`owner/actions`, `owner/status`). After a lost reply or a
   reload, follow that record; never sign or submit again. If the preparation's own reply is lost, no
   `correlationId` reached the page, so it has nothing to follow: nothing was signed or submitted, and a prepared
   action has no effect until it is.
6. **Release independently.** Follow the Invoices asset-service convention
   ([invoices-extraction.md](invoices-extraction.md)): an immutable built artifact that serves only
   public assets, keeps old hashed assets during rollout, and rolls back without touching backend
   records. An owner app can be served by the shared release server (`frontend` host config): the gateway
   checks each release's `contract.json` capabilities, refuses an incompatible release (503, records
   unchanged) and binds the served page to the checked release. A legacy host still serves a directory
   (`frontendDist`). Offline E2E only (`owner-release`, `treasury-release`, `treasury-migration` specs); not deployed.
7. **Test on the stack.** From Proto, build the example (`pnpm example:build`), then
   `pnpm test:e2e:stack --frontend examples/minimal-prototype/dist` (or your own build's absolute path) starts the real
   gateway, agent servers and simulated provider, with owner and payee wallet contexts. See [testing.md](testing.md).
   Write the prototype's own end-to-end check like `test/e2e/minimal-prototype.spec.mjs`.

## The worked example

`examples/minimal-prototype/` is one page bundled with rsbuild (`app.ts`, `index.html`, `rsbuild.config.ts`). It imports
`@multiagency/sdk` (inside Proto the import resolves to the SDK's source; a product installs the package), signs in
through the gateway, reads `overview` for the `payout` agent with `ownerClient`, and pauses or resumes the agent with an
owner-signed `agent_freeze`/`agent_unfreeze` intent. It keeps the prepared owner action's `correlationId` in browser
storage before asking for a signature, and follows that action through a lost reply or a reload without signing or
submitting again. It contains no gateway, executor, credential or callback code.

`test/e2e/minimal-prototype.spec.mjs` builds it and runs it on the real gateway with a simulated provider: owner
sign-in, scoped read, two wallet signatures and two submissions, signed-out scoped calls refused (401), and no transfers.
A second case loses the preparation's reply (the page asks for no signature and keeps nothing), then loses a
submission's reply and the record reads until a reload: after the reload the page reads the recorded outcome, with one
signature and one submission in total. Signatures come from the unfunded fixture key; freeze/unfreeze outcomes come from
the simulator, not an observed provider.

## Gaps

- Host `demo` and agent `area` are fixed enums; a new prototype reuses an existing value or needs a Proto config change.
- Owner procedures outside the Treasury/Payables set (for example `ownerIdentity`, `demoGuide/compose`) have no packaged contract.
- Independent owner-app releases are proven on the local stack only; no deployed host uses the `frontend` release origin yet.
- No app-callback channel exists. Any server-side need is reviewed first (P1 item 3).
- The example is offline-tested only; it has not been deployed or observed on mainnet.
