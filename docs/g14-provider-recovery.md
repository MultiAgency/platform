# G14 investigation — 2026-11-12

## Public API lookup check — 2026-11-12

### Upstream branches, issues and pull requests

Read all paginated public branches and open/closed issues (including pull requests) in
`NEAR-Intents-Agent-API/{sdk-typescript,skills,examples,demo}` on 2026-11-12. No dedicated
original-key read-only lookup proposal was identified in their titles/bodies during that review,
before provider issue #38 was filed (see closeout below). Branch-name review
identified receipt and requested-terms work; this was not a full source audit of every branch.

- [SDK #35](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/pull/35): receipt listing,
  verification and optional payment reference. Its diff says reference is not checked for uniqueness;
  unsettled operations have no receipt. Receipts omit agent/account/key identity. The generated
  verifier describes correlation IDs as random per execution: no documented key derivation emerges.
  These features do not establish the original-key binding for an unknown held withdrawal.
- [SDK #36](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/pull/36): SDK 0.9.0 receipts
  and confidential defaults; upgrading alone is not G14 recovery.
- [SDK #24](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/pull/24): status includes the
  request as admitted. Useful for exact-term validation after identity is established, not for
  establishing identity from the original key.
- [SDK #8](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/pull/8): same-key retry/error
  guidance; no read-only lookup implementation.
- [SDK #11](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/pull/11): operation proofs
  bind agent identity, but require an already known correlation.

The upstream PRs reference server repository `near/near-intents-agent-api` (including receipts
PR #155). Its issues and branches endpoints returned 404 with available GitHub access; the cause
is unknown. Earlier public-org enumeration was therefore insufficient to identify server source.
Provider maintainers may be able to point to relevant server work inaccessible here.

Follow-up alternatives investigation: pinned SDK `a0bff55281d68e2e73a6b179fa2e4ca967a0b069`
`src/idempotency.ts` generates UUID request keys and passes supplied keys unchanged. It contains no
correlation derivation. The client's response handling receives correlation IDs from the server and
adds the effective request key locally. The `op_` plus 43-character pattern alone does not establish
a deterministic algorithm, its namespace or its inputs. Deterministic recovery remains unverified.
The public organization repository listing exposed SDK, examples, demo and skills, not server source.

Offline experiment used the preserved Paperwork pin's in-process payout double from a new temporary
script: one simulated USDC withdrawal accepted with its response dropped; five sequential and eight
concurrent status reads all retained unknown with null correlation; exactly one recorded request
remained. The double's public request inspection also returned null provider status without a
correlation; an initial assertion expecting PENDING_APPROVAL failed and was corrected to reflect
that observable limitation. The corrected assertions passed. No approval or settlement
was attempted for that unknown request. This is a double experiment, not a gateway restart test or
provider evidence. Artifacts: `/private/tmp/g14-single-withdraw.vDDHu7/lost-response.ts` and
`/private/tmp/g14-single-withdraw.vDDHu7/lost-response-result.json`.

No alternative authoritative identity binding was established. A future durable response-capture
layer could narrow a crash window but cannot resolve a response lost before capture. Provider
support for an explicit original-key binding is still needed for this reproduced gap.

Successfully retrieved the live [OpenAPI specification](https://api.agentsonintents.com/openapi.json)
and [provider guide](https://api.agentsonintents.com/llms.txt) in a follow-up check.
The specification snapshot SHA-256 is
`ed4b542dbe14ac12b8549ad148d55c649976730169b55f8bce17c1bb966e4b65`.
Inspection of every GET route found no declared lookup parameter for an original idempotency key.
`GET /v1/status` requires a correlation ID. Agent history accepts cursor, limit and include_unpaid,
and returns StatusResponse records whose schemas do not expose the original idempotency key.
`GET /v1/agents/{agent_id}/provider/{kind}` permits requests/audit/deposit records with limit,
offset and type; its response data is untyped. That route supplies no documented key-to-operation
binding or uniqueness/retention contract. It cannot currently justify automatic reconciliation.

The official SDK main source retrieved alongside this check exposes status, history and provider
record reads, with no original-key lookup method found. GitHub reported main commit
`a0bff55281d68e2e73a6b179fa2e4ca967a0b069`; source and head were fetched separately, so that
commit is provenance context rather than proof of byte-identical source pinning.
No authenticated requests or withdrawals were made. This establishes absence from the inspected
public contract, not absence of an undocumented internal provider capability. Ask the provider for
a supported read-only binding contract; existing list APIs do not establish one.

Automatic recovery without a correlation ID remains unsupported by the platform. This does not
prove the provider lacks an internal lookup: the required authoritative contract remains unverified.
Reviewed source: `0018f55320c4c31054f882b5edb407d912443ba0`.

`src/agent.ts` records the original key and request before submission, claims submission, then
records the response correlation. Response loss after acceptance can leave a claim without that
correlation. `src/payout-requests.ts` refreshes only correlated operations; `src/recover.ts` retains
uncorrelated attempted operations as unknown. The missing binding is original scoped key and exact
payment terms to one provider operation. Matching recipient and amount cannot establish it.

The official [recovery guide](https://github.com/NEAR-Intents-Agent-API/skills/blob/main/near-intents-agent-api/references/status-and-recovery.md)
documents same-key/same-body deduplication across restarts and conflicts for changed bodies.
It documents status reads by correlation and agent history. Its recovery POST requires a correlation
and may dispatch: it cannot serve as read-only identity reconciliation. The guide was retrieved from
the public raw main URL, not a pinned commit; these are documentation claims, not deployed observations.
An earlier OpenAPI retrieval attempt failed; the successful follow-up inspection is recorded above.

Still unverified: a read-only original-key lookup; partner/account/agent/action namespace;
unique binding to complete canonical withdrawal terms; retention and reuse after expiry;
consistency during admission and after timeouts; and authoritative absent versus unavailable results.
A simulator cannot establish these guarantees. Obtain versioned provider documentation or source
and evidence of the deployed contract before implementing recovery.

An operator resolution contract is also unimplemented. It would require authenticated provider
evidence explicitly linking the original scoped key, agent and exact terms to a correlation;
independent operation/approval checks; durable append under the money lock; evidence provenance and
actor auditing; idempotent repeated/concurrent resolution; rejection of competing bindings; and no
withdrawal submission. Manual journal edits do not meet this contract.

Paperwork handoff: retain the existing failing G14 recovery check and committed budget. No verified
SDK/gateway recovery candidate exists from this investigation. The supplied SDK 0.5.9 reproduction
is caller-reported, not rerun here. After provider verification, platform tests must cover response
loss, restart, repeated/concurrent reads, absent/unavailable/conflicting lookup, foreign agent and
mismatched terms. Paperwork then pins an immutable validated candidate, restarts both processes,
reconciles, explicitly approves once and simulates one settlement, asserting one original request,
one provider operation and one payment.

Investigation closeout: no G14 commit or implemented recovery fix was created. The provider request,
[read-only withdrawal lookup by idempotency key #38](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/issues/38),
was created on 2026-11-12 at 23:44:25 UTC and was open at closeout.
[Platform issue #81](https://github.com/MultiAgency/platform/issues/81) remains open: authoritative
lookup is unverified, and the complete restart/recovery/approval/settlement path has not passed.
Retain the failing check, unknown requests and committed budgets.

Repository checks were not run for this documentation-only investigation. The temporary in-process
double experiment described above passed its corrected assertions; it is not a full restart recovery
test or evidence of provider guarantees. No executable changes, release, deployment, owner signatures
or real-money tests occurred. Active-run/freeze ownership was not established by this investigation;
money-path files and frozen artifacts were untouched. At investigation closeout, these documentation
edits were uncommitted and were not included in the released SDK 0.5.9 artifacts.
