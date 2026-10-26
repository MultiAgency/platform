# Standalone Invoices candidate

Invoices' payee frontend is extracted to the [`invoices` repository](https://github.com/MultiAgency/invoices). It builds without importing Proto or Payables source. The extraction includes the Payables working-tree payee work-order request UI and contribution-report app, with a source hash manifest in that repository. Payables and Treasury checkouts were not changed. This is an undeployed candidate; no live credentials or owner actions were issued.

## Ownership and delivery

Invoices owns its invoice/work-order presentation, contribution-report presentation, build and release. Proto owns payee authentication, agent/host routing, invoice identities, compensation records, review authorization, provider integration and guarded dispatch. Owner review remains a Payables responsibility; Proto exposes the compatible owner API. No second executor or database is created by the frontend.

Set `INVOICES_FRONTEND_URL` on the Proto gateway to the dedicated frontend asset service origin. For a directly exposed invoice listener, set it on that process too. HTTPS is required except for loopback HTTP development. This initial shared backend integration requires a reviewed Proto release; subsequent compatible frontend releases do not require a Proto rebuild or restart. Nothing has been configured in production.

The gateway serves presentation through the existing payee host. It forwards neither cookies nor authorization headers to the asset service. Payee API requests continue to the existing executor. The new asset namespace is `/invoice-ui/static/`, leaving Proto's `/static/` consent assets intact. Existing `/i/own-<24 hex>/` entries retain the configured agent, cookie and draft namespace. Unknown instances still refuse; no default executor fallback is added. Root invoice intake still requires the existing configured upstream. The extracted report page is `/report` or `/i/<instance>/report`.

The standalone Node service serves only public assets, GET/HEAD and health. It is not an authenticated gateway and does not proxy API calls. Opening it directly is an asset preview, not a working authenticated product. The owner-facing root and public marketing remain Proto's responsibility.

## HTTP contract

`GET /api/capabilities` returns version 1, product `invoices` and supported capabilities. The frontend publishes `contract.json` with its required capabilities. Proto checks this before serving either HTML entry and refuses incompatible or unreachable releases. This is compatibility checking, not an authorization grant or cryptographic proof that a release behaves correctly. The asset service is a trusted release source; publish only reviewed artifacts.

| Capability | Routes | Authority |
| --- | --- | --- |
| `supplier-session-v1` | GET `/api/session`; POST `/api/signin/challenge`, `/api/signin`, `/api/signout` | Existing NEP-413 payee session |
| `supplier-invoices-v1` | GET/POST `/api/invoices`; POST `/api/invoices/:id/continue` | Signed-in recipient; retained submission identity |
| `supplier-work-orders-v1` | GET `/api/work-orders`, `/api/work-orders/:id`; POST `/api/work-orders/:id/file` | Fixed recipient and order terms |
| `supplier-work-order-requests-v1` | POST `/api/work-orders` | Records proposed terms only; account-bound idempotency; bounded intake |
| `supplier-compensation-v2` | GET `/api/compensation/schema`, `/api/compensation/session`, `/api/compensation`; POST `/api/compensation/signin`, `/api/compensation` | Versioned reports; account-bound session; submission sends no payment |

Apps compile against `@multiagency/sdk` instead of copying these schemas. Its sources are `src/contract/` plus `src/payee-contract.ts` and `src/compensation-contract.ts`, the same files Proto's handlers import. `pnpm contract:pack` writes the tarball, its SHA-256 and provenance (HEAD, dirty paths, per-source hashes) to `.test-artifacts/contract/`; nothing is published. The client never mints identities. It reports 401 as `session` and 403 as `forbidden`, and a 4xx answer as `refused` with its code. A lost or 5xx response to a mutation is `unknown`, echoing the caller's identity, and is never retried. `test/contract-payee.test.ts` runs the client against the real payee handler; type drift between handlers and package fails `pnpm typecheck`. The package version is independent of the wire manifest `version`.

All routes above are relative to the payee instance base. Schema and capabilities are public metadata; private reads/writes still require authentication. The compensation report schema includes `commandId`, request `id`, `expectedVersion`, `report` and `submit`. Exact retries retain their command receipt; altered commands, stale versions and recipient substitution refuse. A new report requires owner-decided compensation with an explicit approved amount; at preparation the owner chooses an isolated order (the default) or the payout agent's shared balance, and a request already bound to one path keeps it. First submission requires exactly the approved observed funding; an accepted or unresolved invoice continues to use its original identity. Historical shared-payment records remain supported without rewriting their identities.

Owner procedures: `compensation/list` is an admitted read; `compensation/agreement` requires management; `compensation/review`, `compensation/prepare`, `compensation/send`, and `workOrders/file` require execution permission. Actual owner/provider authorization and guarded dispatch still apply. Gateway attribution overwrites untrusted actor headers; compensation RPC without a verified actor refuses. Machine delegation gains no new procedures. DAO machine delegation remains refused.

## Records and rollback

Compensation adds `.invoices/<agent>.compensation.sqlite` and its `.initialized` marker. Existing invoice records are not converted. Back up and restore both together with the entire existing state volume, including all owner-intent, operation, strategy, plan, agreement, evidence, inbox and notification records. Missing initialized storage refuses. SQLite transactions retain command receipts and approved compensation under concurrent processes and crash recovery.

Do not delete compensation records to roll back UI. Roll back the frontend service to the prior immutable artifact, retaining old content-hashed static assets for already-open pages. Do not repoint a mutable release during upload; finish and verify the artifact before activation. The gateway does not implement artifact publication or garbage collection. Keep both versions' assets available during rollout. Backend rollback after new compensation records exist needs separate compatibility review; an older backend must not bypass the new report-review requirement.

Without `INVOICES_FRONTEND_URL`, Proto retains its existing embedded invoice page for compatibility. That page does not present the new report UI. A configured but unavailable frontend returns 503 instead of silently switching products; API records remain available to authorized clients. Remote UI cannot replace the shared access route, payee routing, sessions or executor assignments.

## Validation

The local standalone build, typecheck and browser journeys pass. Browser coverage includes mobile layout, accessible labels/controls, drafts, lost responses, session expiry, contribution review and scoped entries with/without trailing slash. Proto's final full offline suite passed 826 tests, including exact-funding compatibility. One unrelated experimental-loader test was subsequently retired with its draft implementation. Targeted routing checks and five real-stack scenarios also passed. Real-stack tests use actual Proto HTTP/RPC, sessions, records, guards and wallet verification with a simulated provider/chain; no real funds move.

Reproduce from Proto:

```sh
pnpm typecheck
pnpm test
node test/e2e/run.mjs --invoices-dist-release <release A> [--invoices-dist-next <release B>] payments.spec.mjs agent-access.spec.mjs
```

The E2E runner snapshots and hashes the actual consumer releases and serves them from the shared release server, a separate process with only `HOST`, `PORT` and `RELEASES_ROOT` in its environment. It verifies invoice → owner approval → settlement, lost submission and signature responses, work-order request intake, report submission and authenticated owner review, plus the existing shared authorization flow. A sixth scenario stops the release server (open pages keep reading records; new loads return 503), starts a compatible release under the same Proto session, refuses an incompatible `contract.json`, and rolls back, with one transfer, one submission and unchanged Proto process ids. Scope-specific browser tests use offline HTTP fixtures. Hosted/mainnet acceptance and every everything-dev runtime integration remain unverified. The frontend is currently a standalone asset service, not a Module Federation remote.
