# Integrated run updates — local implementation

Treasury's run timeline automatically follows recent runs, including after **Run now**. There is
no separate Watch live mode. One **Run timeline** leads with the original outcome, shows recorded
stages directly and retains the receipt under **Run details**. Validated AG-UI snapshots supplement
it with later operation outcomes and explicit read failures. The timeline names later observations
by their recorded swap or shield and links directly
to the operation in Activity. It flags incomplete evidence beside the updates. Historical runs
retain on-request inspection and download; **Refresh outcomes** also reads their latest snapshot.

For ten minutes after a run starts, the executor's private `autopilot/log` procedure is checked every
three seconds until an end is recorded, then every fifteen seconds. Background tabs do not poll.
Pause/resume controls are secondary under **Run details**; they pause only these
supplementary reads, never the executor. The existing timeline continues its own evidence refresh.
At ten minutes, automatic following ends even while paused or disconnected; the panel and its
last-read time remain visible, with a manual refresh action. A manual refresh performs a read
without resuming automatic following. Leaving the page or selecting another run cancels the previous subscription. Approve-only instances
do not start recording reads.

Each refresh validates agent/run identity and schema. Failed reads stop automatic retries and hide
previous supplementary outcomes; the existing timeline is labelled potentially stale. **Retry run
updates** retries only the read. A newly observed end refreshes the existing receipt. Source gaps
are flagged in the panel and detailed in the recording inspector; missing timing stays unknown. No completion is inferred.

New ticks record stage starts and returns for balance reads, recovery, the sweep, planning and
plan execution. The private recording maps these to AG-UI `STEP_STARTED` and `STEP_FINISHED`.
After the provider supplies an operation ID and the journal records `SENT`, a custom submission
observation links to Activity. Acceptance does not prove settlement. The panel announces the last
recorded observation without moving focus; the visible stage list includes its recorded times.
Full balance snapshots, quoted amounts and final operation results still arrive at tick end.
Older runs retain only their original observations; no intermediate history is inferred.
This is snapshot polling, not SSE or timed replay. Updates do not move focus or auto-scroll.

New exports use envelope version 3 and declare AG-UI protocol 1.0. A recorded end closes with
`RUN_FINISHED` only after all observed stages have returned and no explicit run failure was recorded.
Otherwise it emits `RUN_ERROR`, preserving the recorded tick result in metadata. A missing tick end
stays open. This does not turn an operation's failed status into proof of nonpayment. Versions 1/2
remain readable with their original events; legacy readability does not establish lifecycle conformance.

Next actions use existing flow state: an agreed payee still listed in policy prompts sharing the
invoice page; a ready, enabled strategy offers **Follow treasury runs**; recorded or interrupted
runs emphasize **Check operation outcomes in Activity**. Existing held-payout approval and strategy
review/enable controls remain permission checked and retain their confirmations. Missing reads
never advance the flow or automatically trigger a money action.

The Treasury app's `test/browser/run-history.cjs` exercises automatic updates, start/end transitions, later outcomes,
read failure/retry, identity rejection, pause, expiry while paused, manual refresh after expiry,
run changes, navigation cleanup and no writes using synthetic responses at 390px. The loaded view
also receives layout checks at 320px and 1280px. These checks do not establish hosted behavior,
actual screen-reader speech, or provider latency.
Its `test/browser/run-receipt.cjs` checks a terminal v3 recording while the receipt is delayed or fails
to refresh: the known run end stays visible, a missing stage return stays missing, and the original
outcome appears when its receipt becomes readable. No money action is triggered by those reads.

The associated FastNear read correction in `src/chain.ts` distinguishes access failures, rate limits,
transport/HTTP failures and invalid JSON. It does not forward upstream error bodies to the UI.
Malformed responses now refuse the read instead of becoming an empty successful result.
`test/fastnear.test.ts` reproduces the previous behavior and validates the correction offline.
No key, endpoint, authorization rule or retry policy was changed.

Deploy the dashboard, recording reader and executor from the same candidate. Durable progress adds
optional records without converting existing state; follow the [run progress rollout](operations.md#run-progress-rollout).
Follow the rollout and preservation instructions in [Operations](operations.md#releasing-to-both-services).
Both services receive the shared FastNear helper when built from the same candidate. No deployment
or mainnet action was performed during this implementation.


Progress is supplementary: a failed append stops further progress writes for that tick and is
flagged in the end record when it can be saved. The money journal, authorization and recovery
remain authoritative. A missing or damaged progress file yields an explicit gap; only a validated
prefix is displayed. Progress is bounded to 2,000 records and 1 MB per tick. Incomplete exports
read only the selected progress file, without scanning the operation journal or fetching tokens.
Evidence lookup streams a fixed byte snapshot of the append-only file, retaining only the selected
tick. Offline tests cover histories exceeding 8 MB and 20,000 lines, including older exports and
distant duplicate boundaries. A record above 8 MB or more than 20,000 reported evidence gaps
refuses export; lookup time still grows with history. Recording, progress and journal limits remain.

`test/autopilot.test.ts` reads the real export endpoint while settlement is still outstanding.
`test/run-progress.test.ts` covers torn records, identity/order rejection, a child-process exit,
and automatic initialization without rewriting existing state. `test/plan-recovery.test.ts` checks that an observer exception
after recorded acceptance cannot prevent outcome tracking. These are offline checks.
No directory-preparation command is required before rollout.

Recording reads reuse display token metadata for up to five minutes within the same state root and
agent. Concurrent reads share that request; failed refreshes report a gap and can be retried.
`display.asOf` retains the metadata read time. Evidence and operation journals are read fresh for
every snapshot. These behaviors are covered offline by `test/run-log-export.test.ts`.

After a recorded run end, accepted submissions missing from its operation receipt are also matched
to the journal. Later observations remain separate from the original run outcome, and the missing
receipt is flagged as an evidence gap. Conflicting identities are not joined. This recovery display
is covered by offline adapter tests; it neither reconciles nor resubmits an operation.
