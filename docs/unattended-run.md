# Unattended run: observing the treasury autopilot

**Status, 2026-11-25:** this procedure needs a platform build from 0.6.1, which records app calls as interventions
and serves an agent's record over app access. A host on 0.6.0 or earlier records no app call, so a window there can't
be judged by this report. 0.6.1 is not yet released or deployed.

How an observation of the scheduled autopilot, of at least 24 hours, is started, recorded and reported. It answers one
question: does the scheduler run on its own without missed ticks, duplicate execution, actions outside its
schedule, or manual recovery? It says nothing about custody guarantees or economic benefit
([enforcement](enforcement.md)).

## What records the evidence
- **The scheduler itself**, not a watcher, appends synced lines to `.evidence/<agent id>.jsonl` in the
  agent's state directory (on platform staging, `/data/state/.evidence/` on the gateway service's volume). See
  src/evidence.ts.
  - **`start`, written before the tick acts:** a unique tick id, the trigger (`schedule` or `operator`),
    the scheduler's recorded settings (on, interval, limit, and the run its schedule counts from), and the
    build: Railway's deployment id plus sha256 digests of the `src/` tree, `pnpm-lock.yaml` and
    `package.json`. Also the policy revision and digest, the strategy digest, and the live grant's id and
    label (never the token).
  - **`end`, written after:** the book, drift, budget usage and unresolved operations before and after;
    the plan with its legs and quotes; each step's and shield's status and correlation id; rejection
    reasons; a proven refusal's code; and the tick's own summary.
- **Write failures:**
  - If the start can't be written, the tick doesn't run and the inbox says so.
  - If the end can't be written, the inbox says so.
  - A start without an end is reported as incomplete (interrupted, or outcome unknown), never as success
    or failure.
  - A line that doesn't parse, such as a torn final line, is counted as unreadable, not trusted.
  - Every log here appends through one function (`src/synced.ts`). After a torn final line, the next
    record starts its own line, so a crash mid-append loses only the torn line (offline-tested,
    `test/synced.test.ts`).
- **Interventions:** the gateway records every call classified by `isIntervention` in
  `.evidence/interventions.jsonl` (account, agent, procedure, time) before forwarding it, from an owner's session, a
  machine credential, and since 0.6.1 an app under its owner's consent (caller `app:<deployment>:<organization>`). If
  the record can't be written, the call isn't run. Not in this record: calls made on a host directly (CLI, shell), an
  owner's signature submitted on the platform's confirm page, and DAO vote relays.
  An unreadable line in the record is counted and fails the "no operator interventions" criterion, since
  it may have been a call. Builds up to c25b61b skipped such lines instead; `pnpm run-report` refuses a
  gateway that doesn't count them.
- **Reading the records:** on a platform host, as an app deployment under the owner's consent:
  `autopilot/evidence` (`treasury` scope), `ledger` and `GET /apps/v1/o/<organization>/a/<agent>/interventions`
  (`read` scope; hosts listing `interventions-v1`, 0.6.1), none of which is recorded as an intervention. On the
  retired prototype dashboard, `/gw/interventions` with execution or settings permission; in its build fe3330c
  `autopilot/evidence` was operator-only, so the report lists those reads as operator reads, not interventions.
- **The report:** `pnpm run-report` (src/run-report.ts, logic in src/report.ts, tests in
  test/report.test.ts). It reads the evidence, the intervention record and the books, and reports:
  - each criterion;
  - configuration segments (build, mandate or scheduler settings);
  - every tick's outcome: executed, no-op, refused, failed, skipped or incomplete;
  - the incident behind each failed criterion.

Nothing depends on a chat session or a laptop staying up. Collection runs only while a build containing
src/evidence.ts runs on the host serving the agent; app-call interventions are recorded only from 0.6.1. No
unattended window has run on a platform host: as of 2026-11-25, staging holds one tick, from 2026-11-04.

## How the report judges
- **Scheduled work:**
  - Only completed scheduled ticks count. Operator, skipped and incomplete ticks are named inside any gap
    they fall in.
  - Each gap is judged by the interval the later tick recorded, plus 3 minutes.
  - Records are sorted, and both window bounds apply.
- **Duplicates:**
  - "Duplicate references" (an operation or plan named by two ticks) is reported apart from duplicate
    execution.
  - Duplicate execution is confirmed only when one plan leg settled twice. An execution no tick recorded
    with the same terms as one a tick recorded is a suspected duplicate: separate operations can share
    terms.
  - If executions no tick recorded exist without such a match, the answer is "cannot be established",
    not "yes".
- **Unresolved operations** seen at a tick are reported as an observation. Interventions come only from
  the gateway's record and operator-triggered ticks, so "none" means none recorded there.
- **Refusals** show a control was invoked, not that it refused correctly. A failed shield or step, or an error, is a failure.

## Starting a window
1. Deploy a platform build that records app-call interventions (0.6.1 or later), from a release candidate. Record
   the deployment id, image digest, and the candidate's `src/`, lockfile and `package.json` digests.
2. Confirm through the app (`autopilot/get`) that the autopilot is on and hourly, and that the live grant approves the
   strategy in force. Fix the window's length before it starts.
3. Wait for the first scheduled tick. Its start line must match the deployment id and all three digests.
   Its end line fixes the starting book, budget and mandate.
4. The window starts at that tick, in UTC, and ends at the length fixed beforehand, at least 24 h later.

## During the window
- Don't press "Run now".
- Don't force imbalances, raise limits or manufacture trades.
- A correct no-op or refusal is a valid outcome.
- Any operator action, payment or approval in the window is reported as an incident, not hidden.
- If the build, policy, strategy or grant changes, the report starts a new segment. Evidence from earlier
  segments still counts for its own configuration.

## Generating the report
On a platform host, as the app deployment whose consent covers the agent with `read` and `treasury`. Save the
deployment's service credential (`tap_…`) to a 0600 file, never pasted anywhere. Then run:

    PLATFORM_URL=https://api.dev.multiagency.ai APP_CREDENTIAL_FILE=<file> ORGANIZATION=<organization> AGENT=<agent> \
    SINCE=<window start> UNTIL=<window end> OUT=<report.md> pnpm run-report

The prototype dashboard, retired as a host on 2026-11-08 and still runnable from source, takes `DASHBOARD_URL` and a
signed-in `dao_session` cookie in `REPORT_COOKIE_FILE` instead.

## Success
- **The run succeeds when** it has, with incidents recorded honestly:
  - no unexplained missed ticks;
  - no duplicate execution;
  - no execution outside scheduled ticks;
  - no unresolved operation needing manual recovery;
  - every tick able to read its book and mandate.
- **No particular number of swaps is required.**
- **Reported separately from the result:** operational reliability is one thing. Custody guarantees (atomic
  budgets, strict monthly caps, the bought asset) and economic benefit are separate claims that a run of days
  doesn't support.
