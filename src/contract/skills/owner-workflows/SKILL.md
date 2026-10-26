---
name: owner-workflows
description: >
  Use when building an owner-facing app or agent on @multiagency/sdk that reads a MultiAgency agent's records and
  takes owner actions through the gateway: calling ownerClient procedures, following plan execution streams, preparing
  an owner action for the wallet to sign and following its status, and recovering from refused, busy, unresolved,
  provider, unavailable and unknown results without resending. Not for payees (use payee-workflows).
metadata:
  purpose: 'Owner reads, owner-signed actions and money streams with ownerClient, with recovery by result kind and retained identities.'
  type: core
  library: '@multiagency/sdk'
  library_version: '0.2.0'
requires:
  - getting-started
sources:
  - 'MultiAgency/platform:src/contract/owner-client.ts'
  - 'MultiAgency/platform:src/contract/owner-contract.ts'
  - 'MultiAgency/platform:src/contract/owner-outputs.ts'
---

# Owner workflows with ownerClient

Read getting-started first for identities and result kinds. `ownerClient` runs in the owner's browser on the agent's
host, after the owner signed in (the gateway session cookie is sent same-origin). It never retries and never mints an
identity: every action you send carries an identity you keep.

## Setup

```ts
import { ownerClient } from "@multiagency/sdk";

// `base` is the agent's path on its host ("/a/<agent>"), or "" when the page is the agent's own.
export const owner = ownerClient({ base: "/a/payout" });
```

Result: `await owner.call("instance")` answers `{ ok: true, value: { agentId, executor } }` for a signed-in owner;
`session` means sign in first, `forbidden` means this account has no access to this agent.

## Read the agent's records

```ts
import { ownerClient } from "@multiagency/sdk";

export async function heldPayouts(owner: ReturnType<typeof ownerClient>) {
  // A read is safe to repeat once when its answer was lost; any other failure is shown as it is.
  let held = await owner.call("held");
  if (!held.ok && held.kind === "unavailable") held = await owner.call("held");
  return held;
}
```

## Take an owner action: prepare, sign once, submit once, follow its status

The owner's wallet signs exactly the prepared intent. Keep `correlationId` from the moment `prepare` answers.

```ts
import { ownerClient, type OwnerOutput } from "@multiagency/sdk";

// The wallet signs exactly `intent` and answers the intent with its signature fields added (the submit's `signedData`).
type Sign = (intent: NonNullable<OwnerOutput<"owner/prepare">["intent"]>) => Promise<Record<string, unknown>>;

export async function freezeAgent(owner: ReturnType<typeof ownerClient>, signWithWallet: Sign) {
  const prepared = await owner.call("owner/prepare", { action: { type: "agent_freeze" }, signer: "wallet" });
  if (!prepared.ok) return prepared; // nothing to sign yet; `unknown` keeps the action's identity
  const { correlationId, intent } = prepared.value;
  if (!intent) throw new Error("A wallet preparation always carries the intent to sign");
  const submitted = await owner.call("owner/submit", { correlationId, signedData: await signWithWallet(intent) });
  // Lost or unknown: do not sign or submit again. The correlation id finds the outcome.
  if (submitted.ok || submitted.kind !== "unknown") return submitted;
  return owner.call("owner/status", { correlationId });
}
```

Result: `owner/submit` answers the provider status (`{ status: "SUCCESS" }` once applied). `owner/status` answers
`{ stage: "submitted", status }` once the outcome is recorded, `{ stage: "submitting" }` while it is still being
reconciled (read again later), and `{ stage: "unknown" }` for a correlation id this agent does not hold.

## Follow a plan execution stream

`executePlan`, `rebalance`, `sweep` and `steward/propose` are streams. Events are validated one by one; the stream's
final value is `undefined` on success or a failure.

```ts
import { ownerClient } from "@multiagency/sdk";

export async function execute(owner: ReturnType<typeof ownerClient>, planId: string) {
  const events: unknown[] = [];
  const stream = owner.stream("executePlan", { planId });
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return { events, failure: next.value };
    events.push(next.value);
  }
}
```

A failure before the first event keeps its kind (`busy`, `unresolved`, `refused`, `provider`). A failure after any
event is `unknown` with `{ planId }`: part of the plan may have run. Read `activity` and `unresolved`; never execute the
plan again.

## Outside a browser: Treasury's machine route

A Treasury wallet owner can issue a machine credential (`tmc_…`) from the owner's access screen. It works only at
`https://<issued host>/machine/v1/a/<agent>/rpc/*`, only for its scopes (read, prepare, execute-plan, sweep), and never
authenticates `/a/<agent>/rpc`, Payables owner procedures or a DAO's owner actions. The client adds no credential itself:
give it an absolute base and a `fetch` that adds the bearer.

```ts
import { ownerClient } from "@multiagency/sdk";

// `origin` is the issued HTTPS host, `agent` the agent's name, `token` the credential; keep the token out of logs.
export function machineClient(origin: string, agent: string, token: string) {
  const host = new URL(origin);
  if (host.protocol !== "https:" || host.username || host.password || host.pathname !== "/" || host.search || host.hash)
    throw new Error("Use the issued HTTPS origin, without credentials, path, query or fragment");
  return ownerClient({ base: `https://${host.host}/machine/v1/a/${agent}`, fetch: (input, init) => fetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error" }) });
}
```

Result: `await machineClient(origin, "treasury", token).call("overview")` answers like the browser client. A procedure
outside the credential's scopes, or an expired or revoked credential, answers `forbidden` or `session`. Results, streams
and recovery are the same as above: a lost `executePlan` or `sweep` is `unknown`, and nothing is sent again.

## Recover an action that returned no identity

`unknown` echoes the input as `identity`. That is a recovery identity only when the input carries one: `correlationId`
(`owner/submit`, `workOrders/submit`), `planId` (`executePlan`), a work order or invoice `id`, or a compensation
`commandId`. `pay`, `sweep` and `autopilot/tick` take none, and the server's operation key never reaches the caller when
the answer is lost. No read can then link the attempt to one record.

- Read `unresolved`. While it lists an operation, every new money action is refused, so nothing can be sent twice
  meanwhile.
- Read `held`: a payout waiting for the owner's approval is open there, not in `unresolved`.
- Read `activity` for what settled or was refused since the attempt. A row with the same recipient and amount is not
  proof that it is yours.
- Before acting again, have a person decide from those records; never resend automatically.

An `unresolved` row may carry `evidence`: the provider's answer when a claimed submission failed without a proven
outcome. It is diagnostic only. Its `requestId` identifies the failed request to quote to the provider, and
`providerIds` are unverified. Neither is a `correlationId`, neither may be passed to `paymentStatus`, and evidence never
resolves or clears the operation. `evidence` is absent from older servers and null when none was recorded or it was
unreadable.

## Common mistakes

- **Resending after `unknown`** (CRITICAL): the provider may already have accepted it. Read `owner/status`,
  `unresolved` or `activity` by the kept identity instead, or, for an action without one, as described above.
- **Branching on `error` text** (HIGH): messages change; `kind` and `code` are the contract.
- **Treating `forbidden` as an outage** (HIGH): it is this account's access. A DAO member without propose permission
  cannot prepare owner actions; the owner's signature always comes from the wallet or a DAO vote.
- **Retrying money streams automatically** (CRITICAL): `executePlan`, `sweep` and `autopilot/tick` must never be wrapped
  in library retries or refetching.

## Completion

Each action you sent has a read outcome (`owner/status` final, or the operation listed in `activity`), and no
`unknown` remains unread. Report any outcome you could not read; do not act again.
