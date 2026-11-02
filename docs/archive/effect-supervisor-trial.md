# Effect v4 adoption in Proto

2026-10-16, offline-tested candidate, not deployed. **Proto adopts Effect 4.0.5 for gateway child
supervision.** The owner chose adoption after the isolated comparison. Effect is pinned as a
runtime dependency in Proto; Treasury and Payables need no Effect dependency or source changes.

## Boundary and ownership

`src/gateway/supervisor.ts` owns an Effect scope for the gateway and a scoped loop for each child.
Child acquisition registers close confirmation before yielding. Closing the gateway scope interrupts
restart sleeps and triggers child cleanup in parallel. Cleanup signals the child, waits for the grace
period, then attempts SIGKILL and waits for bounded confirmation. Failure to signal or the need for
force makes shutdown return false. Exception contents are not forwarded or logged.

The interface remains synchronous `start(agent)` and `stop(signal): Promise<boolean>`. Duplicate
starts are ignored; starts after shutdown are ignored; concurrent stops share completion; the first
stop selects the shutdown signal. No FiberMap replacement behavior is introduced. The gateway
still launches Node with the tsx loader directly so the supervised PID is the application PID.

Effect stays internal to Proto infrastructure. Gateway HTTP/oRPC contracts, frontend discovery,
supplier links and consumer builds retain their existing types and behavior. The executor lease,
durable journal, dispatch, provider reconciliation and state formats are unchanged by this adoption.
New infrastructure work can use Effect when it provides useful lifecycle or failure ownership;
existing money-path code is not mechanically converted. Any further migration needs its own
reproduced problem, compatibility review and fault tests.

The supervisor uses an explicit root Scope rather than ManagedRuntime or dependency Layers:
this boundary has no application service graph to compose. Scope closure owns its lifetime.

## Trial and promotion evidence

The prior offline trial ran the same six real-process contracts against the Promise-based baseline
and Effect implementation; all passed. Both implementations were approximately the same size
(64 versus 65 lines before promotion). Adoption is an architectural choice for scoped lifecycle
ownership and deterministic time testing, not a measured performance or line-count improvement.
The duplicate implementation has been removed; tests now exercise the production supervisor.

`test/gateway-supervisor.test.ts` covers:

- Duplicate starts, crash restart and cancellation of pending restart.
- Failed executable spawn and backoff.
- Shutdown immediately after startup, with no replacement.
- An unresponsive child requires force and makes shutdown return false.
- The Node/tsx loader supervises the application PID, which is gone after force.
- Both children receive SIGINT before either closes; both are subsequently forced.

`test/effect-supervisor-clock.test.ts` covers synchronous spawn failures, exact exponential delays,
the delay cap, duplicate admission and cancellation after scope closure using TestClock.
`test/effect-supervisor-faults.test.ts` covers missing close confirmation and signaling exceptions.
The latter exposed a promotion defect: a thrown kill call could terminate the release finalizer yet
leave the clean-result flag true. Signaling exceptions are now contained, marked unclean and followed
by the remaining bounded cleanup attempts. The regression failed before this correction.
`test/gateway-lifecycle.test.ts` checks graceful shutdown through the real gateway process.

## Limits

Effect interruption is not proof that a provider submission did not happen. Finalizers cannot run
after the host is killed. Existing journal and reconciliation rules remain responsible for uncertain
outcomes. This adoption neither adds process sandboxing nor distributed executor fencing.
No deployment, production restart, credential rotation, money action or state migration is included.

References: [v4 documentation index](https://effect.website/docs/v4/llms.txt),
[scopes](https://effect.website/docs/v4/resource-management/scope/),
[fibers](https://effect.website/docs/v4/concurrency/fibers/), and
[TestClock](https://effect.website/docs/v4/testing/testclock/).
API signatures were checked against the installed, exactly pinned 4.0.5 source.


## Promotion validation

Typecheck, evidence consistency, 11 targeted checks and the complete 767-test offline suite passed.
The prior 771-test trial count included six duplicate baseline lifecycle cases; those were removed
and two signaling/close-confirmation fault cases added. Treasury's existing independent build passed
its gateway browser contract. The preserved r2 Payables frontend also passed against the current
Proto runtime, using `/tmp/proto-infrastructure-review-20261015-r2/frontends/payables`.

The current Payables checkout has uncommitted compensation changes; its current build fails the
shared-frontend fixture at `compensation/list`, an unrecognized presentation procedure. That consumer
contract is not verified by the frozen-build pass. No Payables files or fixture expectations were
changed to mask the failure. Integration of that consumer feature needs a separate contract review
before releasing a build that includes it. No new frontend package was created for these checks.
