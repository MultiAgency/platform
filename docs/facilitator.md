# Payables

A DAO's payout agent takes payment requests from people outside the DAO, holds funds in its
confidential balance, and files every payment for the DAO's vote. Requesters deal with the invoice
page, never with members. Mainnet: `agentic.sputnik-dao.near`, its payout agent, and
the invoice page at https://invoices.multiagency.ai (retired 2026-11-08).

The [Agent Connect audit and delivery plan](agent-connect-audit.md) maps briefs 01 and 03 to
Payables and brief 02 to Portfolio, and specifies the isolated work-order and
supplier-settlement workflows. Requirement stages below remain the canonical coverage record.

## How each requirement is counted

Every requirement is one of its brief's use cases or outcomes in the Agent Connect experiment catalog, in
the catalog's words where they fit, split where the catalog mixes two kinds:

- A **capability target** describes intended behavior (rebalances, pays an invoice).
- A **safety target** describes an intended constraint (pay an unagreed payee, exceed the budget), and identifies the control or limitation for a
  misbehaving agent: **the signed policy** (the provider refuses under the policy the owner signed, or the
  chain does, as with a DAO's vote), **our server** (only this repo's code holds it, so a user has to
  trust it), **not possible** (nobody can enforce it here), or **nothing yet**.

Every row says how it's known: **observed on mainnet**,
a dated observation with real funds, on this area's own agent or on another (the other area's, or an
isolated test agent), and the row says which; **tested offline**; **per pinned provider source, with deployed behavior unverified**; or **not yet**. The provider and its
custody are still trusted; [enforcement](enforcement.md) sets out how far, and what isn't established.

The app shows only this area's running brief. Public cards show its evidence coverage by observation
scope and its known limitations, without a completion score. The shared signed-in workspace leads
with tasks and status; each area keeps its known limitations beside its detailed evidence.
Mainnet observations do not establish every guarantee. Public cards also show its capability and safety targets,
controls and evidence stages; members follow **Inspect evidence and limitations** on Payments
for the same requirements with their evidence. Roadmap briefs remain below for planning and are
not displayed in the app. Both presentations use the [canonical inventory](../evidence/inventory.ts).
The tables below are generated; edit the inventory and run `pnpm evidence:write`.
`pnpm test` rejects drift.

<!-- BEGIN GENERATED: requirements -->
<!-- Generated from evidence/inventory.ts. Run pnpm evidence:write; do not edit here. -->

## 01 Confidential Treasury Facilitator

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | A contractor invoices the DAO and gets paid | — | Observed on mainnet | Invoices filed at invoices.multiagency.ai, voted and paid on the payout agent, 2026-10-12 and 2026-10-13 (docs/mainnet-log.md; DEMO.md "What is verified") (proposals #47, #50, #53, #54) |
| Capability target | Requests reach the DAO without contacting a member | — | Observed on mainnet | A payee signs in on the invoice page and files there; the DAO votes on the held payment. Invoices filed and paid that way on the payout agent, 2026-10-12 and 2026-10-13 (proposals #47, #53, #54) |
| Safety target | No payment moves without the members' vote | The signed policy | Observed on mainnet | The payout policy holds every payment for the owner, and the owner is the DAO, so only its on-chain vote releases one. Held and released by vote on the payout agent, 2026-10-11 to 2026-10-14 (proposals #26, #47, #53, #54, #56) |
| Safety target | The contractor can't learn the council roster | Not possible on Sputnik | Tested offline | Not possible on Sputnik: a DAO's roles are public on chain. Our invoice page never reads them (test/invoice-roster.test.ts) |
| Capability target | A bounty program pays winners from the private balance | — | Observed on mainnet | The DAO offered an award; the winner filed under it on the invoice page and was paid confidentially from the payout agent after the DAO's vote, 2026-10-14 (test/agreements.test.ts) (proposals #56) |
| Capability target | A new payee's request is routed to a new agreement | — | Observed on mainnet | An account the DAO hadn't agreed to pay filed on the invoice page, 2026-10-14 00:55Z: recorded as an agreement request, nothing sent to the provider, then declined from the dashboard's Agreements (test/invoice-http.test.ts) |
| Safety target | No one outside the DAO's agreement is paid | The signed policy | Observed on mainnet, on another agent | The destination list is the agreement, and changing it takes the DAO's signature. An unlisted account refused with policy_destination_denied on the treasury agent, 2026-10-11; the treasury agent's list changed only by DAO vote (proposals #23, #24, #25) |
| Safety target | An over-limit payment can't go through, even with votes | The signed policy | Per pinned provider source; deployed behavior unverified | Enforced by the signed policy, per OutLayer source (b8c58c0): the keystore re-checks the per-transaction cap before signing, after the vote; not observed on the deployed provider. Our approval re-check is tested offline (test/authorize.test.ts, test/two-machine.test.ts). A cap refusal was seen on the treasury agent, 2026-10-11, with no vote involved |
| Safety target | Chain watchers can't reconstruct the DAO's payout graph | The signed policy | Observed on mainnet | Payees are confidential destinations in the policy, so a public payout matches none. The payout agent's account has no public transactions and the payee sees no sender, 2026-10-11. Limits: each approval is a public proposal whose timing shows, and 1Click and NEAR Intents can see the mapping |

### Known limitations

- The council roster is public on Sputnik.
- Approval timing is public; providers can see the payout mapping. Confidential transfers do not establish protection against every form of tracing.
- Invoice ceilings and deadlines are shown to voters, not automatically enforced.

## 03 Work orders (roadmap)

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | Each work order has a dedicated agent and expiring grant, with owner-approved invoice payment | — | Tested offline | Buyer flow implemented in Payables and the invoice portal. Offline tests cover fixed policy/grant requests, process isolation, authenticated intake, concurrent filing and restart identity (test/work-order-*.test.ts; Payables' test/browser/work-orders.cjs). Funding and settlement on a deployed work-order agent remain unobserved; residual-fund return is not built |
| Safety target | Work-order payments are confidential; business-supplier unlinkability remains unverified | The signed policy | Tested offline | The work-order policy and request require a confidential transfer (test/work-order-binding.test.ts). Provider visibility, timing and public approvals can reveal relationships. No work order paid on mainnet |
| Capability target | Inbound payments are swapped to stables and forwarded to the supplier's treasury | — | Not yet | Not built |
| Safety target | A tampered order (wrong supplier, changed amount, late) is refused | Our server | Tested offline | Work-order dispatch locally binds the exact invoice identity, payee, asset, amount, policy digest and grant deadline. Offline tests refuse altered terms and expiry during final reads (test/work-order-binding.test.ts). No work-order refusal observed on mainnet; accepted payments may finish after the deadline |

## 17 Campaign payouts (roadmap)

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | A winners list is paid in one auditable batch | — | Not yet | Not built: each award is its own invoice and vote |
| Capability target | Recurring disbursements run as scheduled, individually budgeted transfers | — | Not yet | Not built |
| Capability target | Refund waves use the same mechanics | — | Not yet | Not built |
| Safety target | A duplicate winner or inflated prize can't pay twice | Nothing yet | Not yet | Not built: campaign winner identity and prize validation. Offline tests cover only a manual payout matching the recipient, asset and amount of an existing held payout (test/authorize.test.ts), unless the request opts out (allowDuplicateHeld, 0.5.5). Provider replay deduplication is unverified. |
| Safety target | A payout outside the campaign's list is refused | Nothing yet | Not yet | Not built: payees are the policy's agreed list; there is no campaign list |

<!-- END GENERATED: requirements -->

## Gaps

- The running brief’s [known limitations](#known-limitations) include agreement-term enforcement and
  the public council roster.
- A payee must be able to receive confidentially: the provider documents that a confidential transfer's
  recipient needs confidential intents enabled. A requester without it can be agreed but not paid; a public
  payout for them isn't built.
- An agreement request has been filed and declined on mainnet (2026-10-14), but agreeing to one, which
  files a policy update for the DAO's vote, hasn't run yet: record its date and proposal number in
  `docs/mainnet-log.md`, update `evidence/inventory.ts`, then run `pnpm evidence:write` once it has.
- See README **Not done yet** and [enforcement](enforcement.md).

## Next (planned, not built)

- **Auditor access.** A gateway role for an account outside the DAO that may read the policy, mandate
  digest, books and history, and act on nothing: confidential, not unauditable. The Agent API has no
  read-scoped grant, so this is the gateway's allowlist (`src/gateway/allowlist.ts`), not a grant.
