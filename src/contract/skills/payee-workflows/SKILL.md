---
name: payee-workflows
description: >
  Use when a payee (contributor) app or the payee's own external agent works with a MultiAgency payee entry through
  @multiagency/sdk/payee: submitting a compensation report, recovering a lost reply by the report's id, following the
  report to its recorded payment, and starting, listing or revoking an agent connection that lets an agent outside a
  browser report for the payee. Not for owner actions (use owner-workflows).
metadata:
  purpose: 'Payee reports and their payment status with payeeClient, from a browser session or an agent connection, with recovery by kept identities.'
  type: core
  library: '@multiagency/sdk'
  library_version: '0.3.1'
requires:
  - getting-started
sources:
  - 'MultiAgency/platform:src/contract/client.ts'
  - 'MultiAgency/platform:src/contract/agent-connection.ts'
  - 'MultiAgency/platform:src/compensation-contract.ts'
  - 'MultiAgency/platform:docs/agent-access.md'
---

# Payee workflows with payeeClient

Read getting-started first for identities and result kinds. A payee reaches only their own records on one payee entry.
A report records work, with an optional proposed amount; it never sends a payment and is not a money action. The owner reviews it, and the owner's own
signed steps pay it.

Commands that take a structured input (`signIn`, `requestWorkOrder`, `submitReport`, `startAgentConnection`) check it
with the exported schema before sending. Invalid input throws that schema's `ZodError` synchronously and sends nothing;
check it first with the same schema (`reportCommand.safeParse`, …) to show field messages. The client takes no abort
signal; a page that changes account or entry discards late answers itself.

## Setup

In the payee's signed-in browser page (same-origin cookie):

```ts
import { payeeClient } from "@multiagency/sdk/payee";

export const payee = payeeClient();
```

In the payee's own agent, outside a browser, with a connection token the payee started (no cookie is sent):

```ts
import { payeeClient } from "@multiagency/sdk/payee";

export const agentFor = (entry: string, token: string) => payeeClient({ base: entry, token });
```

Result: `await client.compensationSession()` answers `{ ok: true, value: { account } }` for the payee's account.

## Write, save and submit a report

A report belongs to one agreement the payee already holds; the owner records agreements, and a report cannot create
one. Every field is required except `amount`:

| Field | Meaning |
| --- | --- |
| `commandId` | This attempt's identity. Mint once per intended change; a changed payload under the same id is refused (`command_conflict`). |
| `id` | The request's identity. Mint once for a new report; keep it for every revision. |
| `expectedVersion` | `0` for a new request; for a revision, the request's current `version` as last read. |
| `submit` | `false` saves a server draft only the payee sees; `true` sends it to the owner for review. |
| `report.agreementId` | The agreement it bills against. A request keeps its first agreement. |
| `report.start`, `report.end` | `YYYY-MM-DD`, inside the agreement's period. |
| `report.contributions`, `report.assessment` | What was done, and the payee's own assessment. |
| `report.evidence` | Up to 12 HTTPS links, possibly none; the whole report stays within 12 KB. |
| `report.amount` | Optional proposed amount in atomic USDC (`"12000000"` is 12 USDC). The owner approves an amount separately. |

Keep the command durably (in your product's storage) before sending it. After `unknown`, read the request by the `id`
you kept. The read shows the command took effect only when the request's `version` passed the command's
`expectedVersion`: a revision's request already exists at the old version if the lost revision was never applied. Until
then the outcome stays unknown. The entry records each `commandId` with its content, so the person may send the identical
command again: it is applied once, or answers with the result already recorded. Never mint a new `commandId` or `id`
after `unknown`, and never retry automatically. The one case for a new `commandId` is a refusal with `stale_request`:
read the current version and make a new revision on it.

```ts
import { payeeClient, reportCommand, type CompensationRequest } from "@multiagency/sdk/payee";

type Client = ReturnType<typeof payeeClient>;
type Command = Parameters<Client["submitReport"]>[0];
type Report = Command["report"];
/** Your product's durable storage for commands. The SDK supplies none. */
export type Retain = (command: Command) => Promise<void>;

/** A new request on an agreement the payee holds: fresh identities and expectedVersion 0. Sends nothing. */
export async function newReport(client: Client, agreementId: string, fields: Omit<Report, "agreementId">, submit: boolean) {
  const view = await client.compensation();
  if (!view.ok) return view;
  const agreement = view.value.agreements.find(a => a.id === agreementId);
  if (!agreement) return { ok: false as const, kind: "invalid" as const, error: "Choose one of this payee's agreements." };
  if (fields.start < agreement.terms.start || fields.end > agreement.terms.end)
    return { ok: false as const, kind: "invalid" as const, error: `Report inside ${agreement.terms.start} to ${agreement.terms.end}.` };
  return checked({ commandId: crypto.randomUUID(), id: crypto.randomUUID(), expectedVersion: 0, submit, report: { ...fields, agreementId } });
}

/** A revision of a saved draft or a request returned for changes: the same id, its current version, a new commandId. */
export function revision(current: CompensationRequest, report: Omit<Report, "agreementId">, submit: boolean) {
  if (current.state !== "draft" && current.state !== "changes_requested")
    return { ok: false as const, kind: "invalid" as const, error: "Only a draft or a request returned for changes can be revised." };
  return checked({ commandId: crypto.randomUUID(), id: current.id, expectedVersion: current.version, submit,
    report: { ...report, agreementId: current.report.agreementId } });
}

function checked(command: Command) {
  const parsed = reportCommand.safeParse(command);
  return parsed.success ? { ok: true as const, value: parsed.data }
    : { ok: false as const, kind: "invalid" as const, error: parsed.error.issues.map(issue => issue.message).join(" ") };
}

/**
 * One send, only after the command is retained. A lost reply is followed by a read, never by another send: `applied` is
 * true only when the request's version passed the command's expectedVersion. Another tab's revision also moves the
 * version, so compare `request.report` with the command's when that matters.
 */
export async function send(client: Client, command: Command, retain: Retain) {
  await retain(command); // if this throws, nothing is sent
  const sent = await client.submitReport(command);
  if (sent.ok || sent.kind !== "unknown") return { sent, observed: null, applied: sent.ok };
  const observed = await readRequest(client, command.id);
  const version = observed.ok ? observed.value.request?.version ?? 0 : 0;
  return { sent, observed, applied: version > command.expectedVersion };
}

/** Read only: the request, the owner's approved amount and the payment's recorded status. Approved is not paid. */
export async function readRequest(client: Client, requestId: string) {
  const view = await client.compensation();
  if (!view.ok) return view; // reading again is safe
  const request = view.value.requests.find(r => r.id === requestId) ?? null;
  const payment = view.value.payments.find(p => p.requestId === requestId) ?? null;
  return { ok: true as const, value: { request, state: request?.state ?? null, proposed: request?.report.amount ?? null,
    approved: request?.approvedAmount ?? null, payment: payment?.status ?? null, paid: payment?.status === "paid" } };
}
```

Result: `newReport(…, false)` then `send` saves a draft (`state: "draft"`, `version: 1`). `revision(saved, report, true)`
then `send` submits it for review (`state: "submitted"`, `version: 2`). After `unknown`, `applied` says whether the read
shows it took effect; `false` keeps it unknown.

Refusals carry a `code` (status 409, or 404 for `not_found`): `stale_request` (the version moved: read it and revise on
the new version), `request_locked` (not a draft or returned request), `agreement_changed` (a request keeps its first
agreement), `outside_period`, `not_found`, `intake_full` (20 open requests per payee), `identity_conflict` (the `id`
belongs to an agreement), `command_conflict` (the `commandId` was used with other content), and `rate_limited` (429).
Evidence holds at most 12 HTTPS links, and the whole report at most 12 KB.

A request's `state` says who acts next:

| `state` | Next |
| --- | --- |
| `draft` | The payee submits it (a revision with `submit: true`). It isn't in review. |
| `submitted` | The owner reviews it. |
| `changes_requested` | The payee revises it; `feedback` is the owner's reason. |
| `approved` | The owner prepares and pays it. `approvedAmount` is the compensation, whatever amount was proposed. |
| `declined` | Final: no compensation. |

A payment appears in `payments` once the owner prepares one; `request.payment` names its mode. Its `status` comes from
the stored invoice record: `prepared`, `waiting`, `paying`, `paid`, `failed`, `refused`, `unknown` or `needs_review`
(`invoiceStatus` in this package also has `needs_agreement` and `busy`, which only a filing answers and a payment row
never shows). For an isolated order it may also be `preparing`, `expired` or
`unavailable` (the order couldn't be read); a shared payment whose invoice is missing is `preparation_incomplete`. Only
`paid` is settlement. `failed` means the provider reported the transfer failed or refunded. `unknown` and `needs_review`
are unresolved. None of these is a reason for the payee to file a replacement; the owner decides what follows.

## Connect an agent (from the payee's browser session)

```ts
import { payeeClient } from "@multiagency/sdk/payee";

export async function connectAgent(browser: ReturnType<typeof payeeClient>) {
  const started = await browser.startAgentConnection({ label: "Report agent", ttlSeconds: 3600 });
  if (!started.ok) return started; // a lost start is `unavailable`: list connections and revoke any orphan
  // Give `token` to the agent once; it is never shown again. `permissions` is the whole of its reach.
  return { ok: true as const, value: { token: started.value.token, permissions: started.value.connection.permissions } };
}

export async function revokeAll(browser: ReturnType<typeof payeeClient>) {
  const listed = await browser.agentConnections();
  if (!listed.ok) return listed;
  for (const connection of listed.value.connections.filter(c => !c.revoked)) await browser.revokeAgentConnection(connection.id);
  return { ok: true as const, value: listed.value.connections.length };
}
```

An agent connection permits `compensation.read` and `compensation.submit` only. With the token, every other route is
`forbidden`, and an expired, revoked or wrong-entry token is `session`. Connections are managed from the browser
session only: a request carrying a token cannot start, list or revoke one.

## Common mistakes

- **A new `commandId` or `id` after `unknown`** (CRITICAL): it creates a second report. Read by the kept `id`.
- **Using an agent connection to file invoices or work orders** (HIGH): filing stays with the person; the connection
  answers `forbidden`.
- **Reading "approved" as paid** (HIGH): only a `paid` payment status is settlement.
- **Copying the payee's cookie or wallet key into an agent** (CRITICAL): start an agent connection instead.

## Completion

The report's record is read by its `id`, and its payment status is the last value read. If a result stays `unknown`
or `unavailable`, report it with the kept `commandId` and `id`; do not submit a replacement.
