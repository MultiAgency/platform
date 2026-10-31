# Platform reuse map

Which Proto platform pieces each existing workflow used, with the run that shows it. Each workflow
is told in its own repository; this page lists only what it reused. All runs below are local, with the
simulated provider, chain, wallet signatures, deposits and settlement. None is a mainnet observation
or hosted acceptance. Receipts and E2E artifacts are git-ignored local files, recorded 2026-10-16.

## Platform pieces

| Id | Piece | Where |
| --- | --- | --- |
| G1 | Host-bound wallet sign-in and host-local session | `src/gateway/server.ts` (`/gw/challenge`, `/gw/session`) |
| G2 | Scoped agent RPC with per-procedure permission and verified actor | `/a/<agent>/rpc/*`, `src/gateway/allowlist.ts`, `src/gateway/roles.ts` |
| G3 | Payee routing and sessions under the instance base | `src/invoice-http.ts`, `src/gateway/hosted-supplier.ts` |
| O1 | Owner intents: prepare → wallet signature → one submission → durable status | `src/owner-intents.ts`, `owner/*`, `workOrders/{prepare,submit,status}` |
| D1 | One send site with unresolved-operation blocking | `src/agent.ts` `dispatch`, `src/invoices.ts` |
| W1 | Work-order executors: per-order agent, invoice grant, exact funding | `src/work-order-*.ts`, `src/work-orders.ts` |
| C1 | Compensation records and payout preparation (shared payout agent or isolated order, chosen by the owner) | `src/compensation*.ts` |
| M1 | Machine access: shared consent, scoped credentials, `externalPlan` → `executePlan` | `src/gateway/machine-*.ts`, `docs/agent-access.md` |
| F1 | Independent frontend delivery with a capability check | `src/gateway/payee-frontend.ts`, `INVOICES_FRONTEND_URL` |
| S1 | Isolated stack and simulator | `test/e2e/{environment,provider,stack}.mjs`, frozen snapshot `b643b963…1856` |

## Workflows

| Workflow (owner, demo) | Pieces used | Evidence |
| --- | --- | --- |
| Treasury strategy: observe → choose swaps → quote saved plan → authorized execution → exact outcome (Treasury, `demo/treasury-strategy/`) | G1, G2, O1, M1, D1, S1 | Treasury `.test-artifacts/demo/run-rSHrss` and `run-tuOJNU` (result "as expected"); fault run `run-mkep3l` (lost response, result "as expected"). Proto E2E with the actual skill helper: `run-akqeHS` (5 passed), `run-5GCZNy` (15 passed) |
| Sally purchase order: fixed terms → owner authorizes order → simulated funding → payee files → payout approval → outcome (Payables, `workflows/purchase-order.mjs`) | G1, G2, G3, O1, W1, D1, S1 | Payables `.test-artifacts/workflows/purchase-order-2026-10-16T19-08-42-441Z/receipt.json` (7 steps, both sides paid, one transfer; run against snapshot `b643b963…`). Proto `work-orders.spec.mjs` run-nu7Lbw (3 passed) |
| Report to payment: report → owner compensation decision → shared or isolated payout → payout approval → outcome (Payables with Invoices, `workflows/contribution-report.mjs`) | G1, G2, G3, C1, O1, W1, D1, S1 | Payables `.test-artifacts/workflows/contribution-report-2026-10-16T19-05-57-509Z/receipt.json` (11 steps, paid, contributor sees paid). Proto `work-orders.spec.mjs` run-nu7Lbw |
| Community sponsorship: request → held confidential payout → owner approval → outcome (Payables, `workflows/sponsorship.mjs`) | G1, G2, G3, O1, D1, S1 | Payables `sponsorship-2026-10-16T19-04-16-946Z` (settled), `…19-04-50-875Z` (owner rejects; nothing moved), `…19-05-24-073Z` (lost filing response → unknown, same invoice id, one transfer) |
| Independent Invoices release: outage, compatible release, incompatible refusal, rollback without restarting Proto (Invoices, H1) | F1, G3, O1, D1, S1 | Proto `payments.spec.mjs` scenario 6 against the Invoices process: run-gEtffd (6 passed, frontend digest `6881b968…`); run-2XYpcj and run-Sh3P4p (8 passed) |
| New-prototype example: sign-in, scoped read, owner-signed pause/resume (Proto, `examples/minimal-prototype/`) | G1, G2, O1, S1 | Proto `minimal-prototype.spec.mjs` run-r8s3rS (1 passed) |

## What no workflow reuses yet

- The contract package (`src/contract/`) is used by the apps (Treasury installs it from npm; Payables and Invoices link a local checkout), but the workflow receipts above predate that adoption.
- Owner-app capability refusal and independent Treasury and Payables releases are shown only by Proto's offline E2E (`owner-release`, `treasury-migration` specs), not by a deployed host.
- No workflow uses an app-callback channel; none exists.
