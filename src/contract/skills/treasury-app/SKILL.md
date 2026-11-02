---
name: treasury-app
description: >
  Use when an app's server proposes Treasury swaps for an Organization's agent through @multiagency/sdk and has them
  executed once the owner approves later: proposals by requestId, the exact text the owner signs, one execution per
  proposal with recovery by state, and the two Treasury consent scopes. Server side only. Read app-server first.
metadata:
  purpose: 'Treasury proposals through an app: propose by requestId, the owner signs the exact terms, execute once, recover by state.'
  type: core
  library: '@multiagency/sdk'
  library_version: '0.4.0'
requires:
  - getting-started
  - app-server
sources:
  - 'MultiAgency/platform:src/contract/treasury-proposals.ts'
  - 'MultiAgency/platform:src/contract/app-access.ts'
  - 'MultiAgency/platform:src/proposals/service.ts'
  - 'MultiAgency/platform:coordination/durable-proposals.md'
---

# Treasury proposals from an app's server

Read app-server first: the same credential, consent and result kinds apply. An agent runtime (your CLI, an assistant)
calls your server, never the platform. A proposal is a list of swaps your app proposes now; the agent's owner approves
its exact terms later (hours or days), by signing a text in their own wallet; then your server asks for its execution,
which runs once, under the owner's signed policy. No production host serves this yet; build against the SDK
repository's local stack.

Two consent scopes, each named in the text the owner signs:
- `treasury`: Treasury reads (`strategy/get`, `autopilot/get`, `autopilot/evidence`, `autopilot/log`, `treasury/get`),
  strategy settings (`strategy/save`, which act only once the owner signs a grant binding them), `autopilot/enable` and
  `autopilot/stop`, `sweep`, and every `proposals/*` procedure.
- `treasury-execute`, only beside `treasury`: `rebalance`, `externalPlan` and `executePlan`, five-minute plans executed
  within the policy without a signature per swap, and only while the owner's live grant binds the strategy they were
  planned under. `sweep`, `rebalance` and `executePlan` are streams: read them with `app.agent(...).stream(path, input)`.

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
