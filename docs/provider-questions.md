# Questions for the Agent API provider

The open spending-limit cases in [enforcement.md](enforcement.md#open-spending-limit-cases) depend on behavior the
provider owns. These are the questions to put to them, with what we have observed and what would close each case.
They are drafted here and not yet sent; record the provider's answer and link it next to the case when it comes.

## Q1. Is USD-budget charging atomic with admission?

- **Observed:** one concurrent trial on an isolated agent (2026-10-13T03:32Z, [mainnet log](mainnet-log.md#isolated-test-agent-usd-budget-under-concurrency-2026-10-13t0332z)): five simultaneous swaps with room for two; one executed, one got `wallet_busy`, three got `spend_budget_exceeded`, and the budget did not overshoot.
- **Ask:** does admission check and charge the budget in one step, per wallet, across grants and instances? What happens to the charge when the process fails after admission and before submission?
- **Closes (E5–E9):** a written answer, or a repeatable concurrent trial across two grants and after a forced crash.

## Q2. Are cumulative per-asset caps strict under concurrency?

- **Observed:** a sequential monthly-cap refusal (2026-10-13T03:27Z). Upstream tests describe one of two simultaneous spends passing against one limit; not observed on the deployed route.
- **Ask:** is the per-asset usage row shared by every caller of a wallet (grants, instances), and written while the wallet is held?
- **Closes (E2–E4):** a written answer, or a concurrent trial across grants and instances on the deployed route.

## Q3. Will output-asset limits ever be enforced at admission?

- **Observed:** a swap into an asset outside `assets` succeeded (2026-10-10); the provider documents `assets` as spend-only.
- **Ask:** is output-asset admission planned? If so, which version, and how will it be advertised?
- **Closes (E1):** an answer. The local rule (`outputAssetRefusal`, `src/policy.ts`) stays regardless.

## Local checks that hold without the provider

`test/spend-concurrency.test.ts` covers the executor's own side: one lock holder among many simultaneous attempts,
no two sends in flight at once, a distinct idempotency key per send, and every later attempt refused while an
earlier outcome is unproven. It does not test the provider's counters.
