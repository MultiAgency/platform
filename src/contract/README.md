# MultiAgency SDK

Build a product interface or an external agent that uses Proto's existing agreements, contribution reports, payments and Treasury workflows. The SDK supplies clients, response schemas and recovery outcomes. Proto keeps identity, authorization, authoritative records and guarded execution.

Start with one supported workflow. A product may provide its own screens, navigation, drafts and preferences while calling the same platform. A new server-side domain or authority model needs a platform extension; importing this package does not create one.

## Install the package

The SDK is published on npm under the Apache-2.0 license:

```text
pnpm add @multiagency/sdk zod@4.6.7
```

Each package carries `provenance.json`: the source commit it was packed from, any uncommitted paths in that tree, and a digest for every file it was built from. One version number identifies one package: npm does not let a published version be republished with different contents (per npm's documented policy). The package's own README, skills and `CHANGES.md` describe that exact version.

Zod is the one peer: a product's schemas and the SDK's share one Zod. The owner entry (`@multiagency/sdk`) brings its own `@orpc/client` and `@orpc/contract` 2.0.0-beta.46 and `@ag-ui/core` 1.0.3 as dependencies, so a product on another oRPC version keeps it; its bundle then carries both oRPC clients. The contributor entry never loads them. The installed package's dependencies and peerDependencies are authoritative for that package. The supported Node target is Node 24. TypeScript consumers use ESM with NodeNext resolution and the ES2023 and DOM libraries for the clients' web request types. The Node-only release-server entry also needs Node typings.

For development against unreleased SDK source, install an SDK repository checkout's dependencies and run `pnpm sdk:dev --once` there, then link your product to its generated `packages/sdk` directory. Use `pnpm sdk:dev` to watch changes. The generated directory is not source and is intentionally absent from Git. A linked checkout can differ from the published package of the same version, so record which one a release was built with, and keep local paths out of portable release inputs.

## Choose the client and supported access

| Product or caller | Client | Required access |
| --- | --- | --- |
| Owner-facing browser product | `ownerClient` from `@multiagency/sdk` | A host-local owner/member session and access to the configured agent |
| Contributor-facing browser product | `payeeClient` from `@multiagency/sdk/payee` | The contributor's session on that contributor entry |
| Contributor's external agent | `payeeClient({ base, token })` | An expiring, revocable report connection started by the contributor |
| Treasury external agent | `ownerClient` with an absolute machine base and a `fetch` that adds the bearer | An existing wallet-owner-issued Treasury credential with the required scopes; see owner-workflows |
| An app's server (for example the MultiAgency dashboard) | `appClient({ base, credential })` from `@multiagency/sdk` | The deployment's operator-issued service credential, plus a live owner consent per Organization and agent |

The Proto operator configures a browser product's host, reachable agents and frontend release. Browser products use that host's gateway and session. A custom frontend does not receive a provider key or grant, and cannot choose another host's agents.

An app's server reaches agents under `/apps/v1` and never from a browser: the service credential is a server secret. The
owner signs `consentMessage(...)` (or `setupMessage(...)` for a hosted agent) with NEP-413 in the app; the server submits
it. A consent reaches the listed reads (`APP_READS`) and owner actions (`APP_OWNER`) and, for `owner/prepare`, only
actions the owner can read when signing or that platform code builds entirely (`AppOwnerAction`); everything else is
refused. The app never asks an owner to sign the platform's sign-in text. See the platform's `docs/agent-access.md`,
"App access". The `/apps/v1` routes are not yet deployed on any hosted MultiAgency host; they run on the SDK repository's
local stack (`pnpm test:e2e:stack --app <deployment>`), with a simulated provider, chain and wallet.

An agent connection permits its contributor's reports and compensation reads only. It cannot file invoices, approve payments, sign owner actions or manage connections. Treasury machine access is a separate existing route and credential; Payables owner delegation and DAO machine delegation are unavailable.

## First read from a browser product

After signing in on the product's configured host, use the configured agent key:

```ts
import { ownerClient } from "@multiagency/sdk";

const owner = ownerClient({ base: "/a/payout" });
const overview = await owner.call("overview");

if (overview.ok) {
  console.dir(overview.value);
} else {
  console.log(overview.kind);
}
```

Replace `payout` with the key configured for your host. Use the typed response to render your screen. A `session` result needs sign-in; `forbidden` means this identity lacks access. Capability and permission helpers can guide what to display; the server authorizes every request.

The SDK repository's `examples/minimal-prototype` is the browser reference: a page bundled with rsbuild that imports `@multiagency/sdk`, signs in through the gateway, reads its agent and takes one wallet-signed owner action, keeping the prepared action's `correlationId` across a lost reply and a reload. Its end-to-end test runs it on the isolated stack with a simulated provider. Use the public clients rather than reproducing the RPC wire format.

## First read from a contributor agent

Have the contributor start a report connection from their signed-in application. Give the agent the connection token and the API entry base: the origin, or the origin plus `/i/<instance>`. Do not use a page URL ending in `/submit` or `/report` as the API base.

```ts
import { payeeClient } from "@multiagency/sdk/payee";

const entry = process.env.MULTIAGENCY_ENTRY;
const token = process.env.MULTIAGENCY_REPORT_TOKEN;
if (!entry || !token) throw new Error("Provide the contributor API entry and report token.");
if (new URL(entry).protocol !== "https:") throw new Error("Use the HTTPS contributor entry.");

const contributor = payeeClient({ base: entry.replace(/\/$/, ""), token });
const session = await contributor.compensationSession();
if (!session.ok) throw new Error(`Contributor access: ${session.kind}`);

const records = await contributor.compensation();
if (records.ok) {
  console.log(records.value.agreements.map(a => ({
    id: a.id, title: a.terms.title, remainingAtomicUsdc: a.remaining,
  })));
} else {
  console.log(records.kind);
}
```

The token is sent as a bearer without browser cookies. Keep it out of source, URLs and logs. An agent never needs the contributor's wallet key or an exported browser cookie.

## Build the report workflow

1. Read and select the intended agreement. Its scope, period and remaining allowance bound the work; allowance is not an earned amount.
2. Construct the complete report command using the payee-workflows example. Save its request ID, command ID and exact contents before sending.
3. Use `expectedVersion: 0` for a new request. For a revision, keep the request ID and use its current returned version with a new command ID for the new intended change.
4. `submit: false` saves a server draft; `submit: true` sends the report to owner review. Only a draft or a request returned for changes can be revised.
5. An optional report amount is a proposal in atomic USDC: `"12000000"` is 12 USDC. The owner chooses a separate approved amount.
6. After `unknown`, keep the exact command and read the original request by its ID. Recovery is a read. Do not create a replacement or resend automatically. The entry records each `commandId` with its content: sending the identical command again returns the original record, and a different payload under the same `commandId` is refused with `command_conflict`. A missing request after `unknown` does not prove that nothing was recorded.
7. Match the returned payment by request ID. An approved report is not a paid payment: only a payment whose status is `paid` reports recorded settlement. Display the last recorded status as read.

Refusals carry a `code`, for example `stale_request` (the version moved; read it again), `request_locked` (already submitted, approved or declined), `outside_period` (the report period must fit the agreement), `agreement_changed` (a request keeps its first agreement), `not_found`, `intake_full`, `identity_conflict` (the request's `id` is already used), `command_conflict` and `rate_limited`.

Validate fields with `reportCommand.safeParse` before sending. Invalid structured input throws a Zod validation error locally and sends nothing.

## Handle outcomes explicitly

Reads may be repeated after `unavailable`. `session` and `forbidden` require different user actions. A typed refusal says the action did not proceed; correct the stated cause before another intended action. An `unknown` action may have taken effect. Preserve its available identity and follow the documented reads.

The SDK never automatically resubmits an action. Some owner procedures have no caller-held lookup identity; the owner-workflows skill describes their limits. Diagnostic provider request IDs are not verified operation links. An unresolved payment may continue blocking its agent until a supported resolution exists.

## Continue with the bundled guidance

The package contains `skills/getting-started/SKILL.md`, `skills/payee-workflows/SKILL.md` and `skills/owner-workflows/SKILL.md`. These files describe the clients in the installed package and can be read directly or through TanStack Intent. `CHANGES.md` records consumer-impacting changes.

Use `@multiagency/sdk/schemas/*` for the published JSON schemas. The Node-only `@multiagency/sdk/release-server` serves immutable frontend artifacts; it does not authenticate callers or run a financial executor.

For a local rehearsal, the SDK repository's existing simulated stack supplies the gateway and provider fixtures. Keep simulated sign-in, approvals, funding and settlement visibly separate from the product's SDK calls. A successful simulation does not authorize a hosted deployment or financial action.
