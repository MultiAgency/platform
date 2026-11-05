---
name: treasury-app
description: >
  Use when an app's server proposes Treasury swaps for an Organization's agent through @multiagency/sdk and has them
  executed once the owner approves later: proposals by requestId, the exact text the owner signs (or a DAO's vote), one
  execution per proposal with recovery by state, and the two Treasury consent scopes. Server side only. Read app-server first.
metadata:
  purpose: 'Treasury proposals through an app: propose by requestId, the owner signs the exact terms, execute once, recover by state.'
  type: core
  library: '@multiagency/sdk'
  library_version: '0.5.2'
requires:
  - getting-started
  - app-server
sources:
  - 'MultiAgency/platform:src/contract/treasury-proposals.ts'
  - 'MultiAgency/platform:src/contract/app-access.ts'
  - 'MultiAgency/platform:src/proposals/service.ts'
  - 'MultiAgency/platform:docs/enforcement.md'
---

# Treasury proposals from an app's server

Read app-server first: the same credential, consent and result kinds apply. An agent runtime (your CLI, an assistant)
calls your server, never the platform. A proposal is a list of swaps your app proposes now; the agent's owner approves
its exact terms later (hours or days), by signing a text in their own wallet; then your server asks for its execution,
which runs once, under the owner's signed policy. No production host serves this yet; build against the SDK
repository's local stack.

Two consent scopes, each named in the text the owner signs:
- `read` (beside the scopes below) for the owner UI's frame: `account` gives the agent's wallet account and the grant
  the executor holds (`grant`, plus `stagedGrant` while a new one waits to be promoted); `reconcileBooks` gives each
  balance against its independent record. Follow unresolved operations with `unresolved`; the platform reconciles them
  itself, and an app never calls `recover`.
- `treasury` also covers, from 0.5.1: "Run now" (`autopilot/tick`, swapping only under the owner's grant for the saved
  strategy and within its per-run ceiling); for a wallet owner, the linked treasury account (`treasury/link`, `unlink`,
  `setConfidential`, refused for a DAO-owned agent); and funding (`deposit`, then the SDK's `fundingTransaction` for the
  transfer the owner or the DAO signs).
- `treasury`: Treasury reads (`strategy/get`, `autopilot/get`, `autopilot/evidence`, `autopilot/log`, `treasury/get`),
  strategy settings (`strategy/save`, which act only once the owner signs a grant binding them), `autopilot/enable` and
  `autopilot/stop`, `sweep`, `deposit` (a one-time address that credits the agent, to fund it), and every `proposals/*` procedure.
- `treasury-execute`, only beside `treasury`: `rebalance`, `externalPlan` and `executePlan`, five-minute plans executed
  within the policy without a signature per swap, and only while the owner's live grant binds the strategy they were
  planned under. `sweep`, `rebalance` and `executePlan` are streams: read them with `app.agent(...).stream(path, input)`.

## Where the limits are

The owner's signed policy is the boundary, and the provider enforces it on every path: proposals, `treasury-execute`
and the owner's own actions. It sets per-asset caps per transaction, hour, day and month, and a USD budget across
assets. Per the Agent API's docs, each budget cap runs in fixed daily, weekly or monthly periods counted from when the
owner turned it on, not a rolling window, so up to twice a cap can move across a reset; a smaller shorter cap or a
per-asset hourly limit bounds that. These are absolute amounts, not a share of the treasury, and they bound spending,
not exposure. No consent or credential has a budget of its own, and a
proposal's approval is the platform's check, not the provider's. Limits your app keeps in its own process (a share per
order, orders per hour) are your app's rules, not a boundary: whoever holds the agent's treasury grant can act without
them. To change a limit, the owner signs a policy update. What each limit is known to guarantee:
[enforcement, "The envelope"](https://github.com/MultiAgency/platform/blob/main/docs/enforcement.md#the-envelope).

## Propose, once per requestId

Store the `requestId` (1–64 of `[A-Za-z0-9_-]`) and the request before calling. `legs` is your chosen swaps in raw units
(at most 8; a `minAmountOut` you require is kept if it is above the quote's floor), or `"strategy"` for the legs a
rebalance toward the owner's strategy picks now. `expiresAt` is at most 7 days ahead.

```ts
import { appClient, proposalText, type ProposalView } from "@multiagency/sdk";

type Request = { requestId: string; legs: { from: string; to: string; amount: string; minAmountOut?: string }[] | "strategy"; expiresAt: string };
type SignNep413 = (message: string, recipient: string, nonce: Uint8Array) => Promise<{ publicKey: string; signature: string }>;

export async function propose(app: ReturnType<typeof appClient>, organization: string, agent: string, request: Request) {
  const calls = app.agent(organization, agent);
  const made = await calls.call("proposals/create", request);
  if (made.ok || (made.kind !== "unknown" && made.kind !== "unavailable")) return made;
  // The answer was lost: the same requestId and request answer the stored proposal and store nothing new.
  return calls.call("proposals/create", request);
}

export async function approve(app: ReturnType<typeof appClient>, organization: string, agent: string, host: string,
  proposal: ProposalView, sign: SignNep413) {
  // The platform accepts only this exact text; show the owner this text, which their wallet shows as it signs.
  const message = proposalText(proposal, "approve");
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const { publicKey, signature } = await sign(message, host, nonce);
  return app.agent(organization, agent).call("proposals/approve", { id: proposal.id,
    signed: { message, nonce: btoa(String.fromCharCode(...nonce)), publicKey, signature } });
}
```

Result: `{ ok: true, value: proposal }` with `state` `proposed`, then `approved`. The text names each swap with its
floor (the least it may return), the policy revision and strategy it was proposed under, the expiry and the
proposal's sha256; the host is the NEP-413 recipient. Approving records the signature and sends nothing. Refusals carry
`code`: `request_conflict` (another request under that `requestId`), `expiry_invalid`, `too_many_proposals`,
`not_proposable` (a provider warning, an output the policy forbids, a floor above the quote, cost over the strategy's
limit, or a balance short: the message says which), `signature_invalid`, `invalidated` (the policy, strategy or agent
changed since: propose again), `not_open`, `expired`, `withdrawn` (made under a consent that has since ended). The owner
rejects with `proposalText(proposal, "reject")` and `proposals/reject`; your app withdraws with `proposals/withdraw`.

## Execute once, and follow it

```ts
import { appClient } from "@multiagency/sdk";

export async function execute(app: ReturnType<typeof appClient>, organization: string, agent: string, id: string) {
  const calls = app.agent(organization, agent);
  const ran = await calls.call("proposals/execute", { id });
  if (ran.ok || (ran.kind !== "unknown" && ran.kind !== "unavailable")) return ran;
  // The answer was lost: read the proposal. Never propose the same swaps again because of a lost answer.
  return calls.call("proposals/get", { id });
}
```

Result: the proposal, `state`:
- `executed`: every swap succeeded; `operations` lists them.
- `stopped`: claimed, then a swap didn't succeed or was refused, or nothing was sent. It never runs again: propose the
  rest anew.
- `unknown`: a swap's outcome isn't proven. It blocks the agent's sends until resolved and is never resent: read later.
- `executing`: running now; read later.
- `invalidated`, `expired`, `rejected`, `withdrawn`: it ended without running.

A refusal `not_executable` means the attempt was refused before anything was claimed (price below a signed floor, a
provider warning, a short balance, no live treasury grant, the policy not in force): nothing was sent, the proposal
stays `approved`, and asking again later is safe. `not_approved`: the owner hasn't approved it. Execution re-quotes
every swap and sends each with a floor at least the signed one.

## A DAO-owned treasury: the DAO approves by vote

When `identity` answers `signer: "dao"`, the DAO approves or rejects a proposal by its vote. The platform files the
vote from the proposal's own text; your app never builds or relays an approval text (app-server, "A DAO owner").

```ts
import { appClient } from "@multiagency/sdk";

type MemberSigns = (transaction: { receiverId: string; actions: readonly unknown[] }) => Promise<void>;

/** The DAO's vote on one of your proposals: reading its state after the vote passed relays it; then execute as usual. */
export async function daoApprove(app: ReturnType<typeof appClient>, organization: string, agent: string, proposal: string,
  memberSigns: MemberSigns, memberVotes: boolean) {
  const filed = await app.daoVotes.file({ organization, agent, proposal, verdict: "approve" });
  if (!filed.ok) return filed;
  const transaction = memberVotes && filed.value.transactions.proposalAndVote ? filed.value.transactions.proposalAndVote : filed.value.transactions.proposal;
  if (transaction) await memberSigns(transaction);
  // `pending` until the vote passes: read again later with the same id.
  return app.daoVotes.state(filed.value.request.id);
}
```

Result: `pending`, then `relayed` with `proposalState` (`approved`). Nothing relays the vote until your server reads
`state` after it passed: keep reading until it's final. Then `execute(...)` as above. A vote must pass
before the proposal's `expiresAt` and while the DAO consent it is filed under is live. Proposals have no provider
window, so they suit a DAO whose votes take hours or days; the strategy grant autopilot needs is a provider intent that
expires in about 290 s, which only a DAO voting that fast can sign (app-server, "A DAO owner"). A swap's signed floor may be out
of reach by then: execution is refused `not_executable` and the proposal stays approved.

Unattended swaps are the DAO's grant vote: the `treasury` grant, prepared with `owner/prepare` and `signer: "dao"`,
binds the saved strategy. Its proposal says it authorizes swaps without a vote each time and names that strategy (its
digest suffix, targets, cost cap and the autopilot's per-run ceiling); show members the same terms from `strategy/get`
before they vote. Under it, autopilot runs once your app turns it on (`autopilot/enable`), and with `treasury-execute`
(only if the DAO voted it into its consent) your plans run. Saving another strategy needs a new grant vote, and
invalidates open proposals.

## Common mistakes

- **Building your own approval text** (CRITICAL): sign only `proposalText(proposal, "approve")` from the proposal the
  platform returned; any other text is refused, and a summary of yours is not what the owner signs.
- **A new requestId after `unknown`** (CRITICAL): the swaps may have run. Read `proposals/get`.
- **Treating `stopped` as nothing sent** (HIGH): read `operations`; a swap may have succeeded before it stopped.
- **Asking for `treasury-execute` when proposals suffice** (HIGH): it lets your app swap within the policy without a
  signature per swap. Ask for it only when the owner wants unattended execution.

## Completion

Every proposal you created has a read state; none reads `unknown` or `executing` without a later `proposals/get`.
Report anything you could not read; do not act again.
