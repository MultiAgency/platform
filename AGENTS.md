# Agentic Treasury — agent guide

An AI agent moves a DAO's or wallet's funds on NEAR Intents mainnet, only inside a policy the owner
signed. The product is **credibility**: a reviewer must be able to check every claim we make. Real
funds move; treat every change near the money path as a change to a bank.

Vocabulary is in `CONTEXT.md`: use its terms in code, tests, docs and conversation (owner, executor,
policy, grant, purpose, authorization, operation, unresolved, held payout, refusal). Read it first.

## Where things are
- `.agents/skills/` — individually discoverable stack skills with primary sources and verified integration notes. Read the relevant skill before stack-related implementation or review. `.claude/skills` links to the same directory.
- `README.md` — what runs, how to start it, the two areas (Payables, Treasury), and **Not done yet**.
- `docs/facilitator.md`, `docs/treasury.md` — each area: its briefs, each requirement's stage, how each claim is
  known, what isn't covered.
- `docs/architecture.md` — which files are shared core, facilitator or treasury; the one send site; how
  the money path stays safe on one host (journal, reconciliation, checks before each send, invoices).
- `docs/operations.md` — deployment, executor migration, state preservation, the unattended-run report.
- `docs/enforcement.md` — what the signed policy guarantees today, how each part is known, and what a
  stronger claim needs (threat model, obligations, open cases, provider questions).
- `docs/mainnet-log.md` — every dated mainnet run, with proposal numbers; op ids and tx hashes are in the private release record.
- `DEMO.md` — the hosted walkthrough (kept out of the app so copy edits don't redeploy `dao`).

## The money path
Files: `src/agent.ts` (dispatch), `authorize.ts`, `lock.ts`, `ops.ts`, `plans.ts`, `treasury.ts`, `autopilot.ts`,
`invoices.ts`, `invoice-store.ts`, `payouts.ts`, `payout-requests.ts`, `recipients.ts`, `payment-approval.ts`, `owner-intents.ts`,
`owner-requests.ts`, `owner.ts`, `recover.ts`, `reconcile.ts`. Invariants every change keeps:
- **One send site.** Every submission (dashboard, CLI, invoice, payout request, autopilot) goes through `dispatch`:
  under the money lock, no unresolved operation, write-ahead record, then send.
  `test/send-path.test.ts` enforces it.
- **Fail safe.** An unknown outcome stays unresolved and blocks new sends; it never authorizes
  another send. Ambiguous replay stays blocked. Missing evidence refuses; it is never trusted.
- **Provider-first.** The provider enforces the policy; `authorize.ts` adds only checks the provider
  can't make (policy in force, live grant for the purpose, output asset, duplicate held payout, plan
  binding). It is pure: no fetch, send, record or `Date.now()`. Ask before adding a rule there.
- **One executor per agent.** Any other instance runs `EXECUTOR=off` (approve-only: reads and
  approves, never sends). The lease is single-host, not distributed fencing; say so where relevant.
- **Approvals are verified from provider evidence** and re-checked right before signing; an attempted
  owner signature is poll-only after restart, never resubmitted.
- **Mandate digest** (`src/mandate.ts`) is recorded with every plan and money action.

## Live systems
- Hosts: https://proto.multiagency.ai (`dao` service: gateway + treasury executor + payout
  approve-only) and https://invoices.multiagency.ai (payout executor). Railway, one replica each,
  state on the `/data` volume.
- Deploys, restarts and dashboard money actions are the user's. Prepare and verify; let them ship.
- The signed-out public page shows the two areas and each requirement's stage, never the evidence,
  and reads nothing from the server: no balances, amounts, payees, policies, invoices, roster or
  proposals. `test/public.test.ts` pins `web/src/public.tsx`.
- `pnpm test:live` moves or touches real funds: run only when asked, never scheduled. `pnpm smoke` is the read-only check of both hosts.
- An unattended run or freeze may be in progress: ask the user before editing money-path files.

## Calibrated claims

`evidence/inventory.ts` is the canonical requirement/evidence inventory. The app imports it;
`pnpm evidence:write` generates the area tables and DEMO verification section. Do not hand-edit
generated sections. Record dated observations in `docs/mainnet-log.md`, reference them in the
inventory, then regenerate. README and walkthroughs link to the canonical presentations.
`pnpm evidence:check` and `pnpm test` reject generated-document drift.

Every sentence in README, DEMO.md and docs states exactly what was shown, and how:
- Mainnet facts cite evidence: date (UTC), proposal number, deployment id. Op ids, tx hashes, amounts,
  payees and the DAO's caps and budget stay in the private release record, never in tracked docs.
- Distinguish *offline-tested*, *mainnet-observed*, *per provider docs/source (pinned commit)*, and
  *unverified*. A deployed provider version is never assumed from its source.
- A newly found gap goes into **Not done yet** or `docs/enforcement.md` in the same change.
- A claim the code no longer supports is fixed or removed in the same change.

## Working here
- Other sessions edit this repo concurrently. When files change unexpectedly, check which sessions
  are active and ask the likely owner before editing or attributing; agree on file ownership.
- Designs already confirmed with the user (authorize, journal, owner-intents) are built as recorded;
  settled questions stay settled.
- Reproduce before fixing: a failing test, an offline fault test, or recorded mainnet evidence.
  Provider behaviour is a hypothesis until observed or found in pinned source.
- Tests are offline by default (`test/offline.env`). Crash and concurrency tests use real SQLite and
  child processes; keep them that way.

## Done means
- `pnpm typecheck` and `pnpm test` pass; new money-path behaviour has a test that fails without it.
- `CONTEXT.md` updated when a concept is added or renamed.
- README/DEMO/docs claims match the change (see Calibrated claims).
- State-format changes ship with a migration that requires a stopped executor and preserves every state directory
  (canonical list in `docs/operations.md`): `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/`, `.hosted/`, `.agent-connections/`, `.machine-auth/`, `.app-access/`.
  Additive optional records that need no conversion of existing state (such as run progress) need
  compatibility tests and preservation instructions, not a directory-creation migration.
