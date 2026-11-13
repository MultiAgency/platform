# Interactive Payables guide

Historical prototype: the interactive rehearsal page and its browser suite have been removed. The guide RPC/model code, inference wrapper and their exclusive tests have also been removed. The sections below are historical.

The signed-in demo index and Payables walkthrough link to
`/a/<agent>/demos/payables/play`. The agent must be a Payables agent accessible to the member.
The public entry remains static and has no simulated approvals or private reads.

## Experience

- **Watch:** explicit Play starts a scripted, fictional agreement → invoice → held payout → sample
  approval → sample provider outcome sequence. Pause, rewind and restart are local. Background tabs
  pause playback. Reload starts the rehearsal again. There are no wallet or payment calls.
- **Try:** take over at the current scene and explore approval, rejection or an unknown outcome.
  Unknown outcomes stay unknown; the rehearsal offers restart, not another send.
- **Use my agent:** shows the existing live review controls and their exact-record outcome tracking.
  The four-chapter signing guide opens agreement and policy/grant controls in place. Users can
  explicitly invoke the existing wallet or DAO signing flow; generated prose never supplies its payload.
  Entering this mode does not prepare, sign, submit or approve anything. Once mounted, these controls
  stay mounted across mode switches to preserve existing review/stream state; they are hidden in
  rehearsal. No sample record or selection is transferred into them. Live page reads may refresh
  retained observations as the existing controls do.

The initial scenes are authored. Asking a question explicitly invokes the model, which returns a
title, explanation, focus/compare layout, catalog panels and suggested choices. The application
renders fictional facts and approval explanations from its own catalog; model prose is labeled
as explanatory and is never used as authority. The question box does not receive signatures.
Real signing payloads are prepared by the existing owner-intent path, not the model.

## Generation boundary

`src/payables-guide.ts` defines the strict schemas, scene transition rules and
`multiagency.payables.guide` AG-UI CUSTOM event. The event describes a UI, not an executor run.
Only predefined panel and action identifiers are accepted. There are no fields for HTML, scripts,
URLs, handlers or transaction payloads; additional schema fields are rejected. Generated prose
renders as plain text, including any markup-like text. Live scenes reject simulated
record panels and simulated approval/rejection choices. The client validates events again, checks
their mode/stage/role and drops late responses after a scene change or unmount.

`src/payables-guide-model.ts` requests one `generateUserInterface` function response through the
existing NEAR AI Cloud verified transport. It invokes no planning tools.
The response must pass the existing `provider_tee` verification and then the scene schema before
rendering. Generation and verification together have a 60-second application deadline. The
completion request has a shorter timeout and no SDK retries; SDK verification may finish after
the application deadline, but its result is discarded. This is not a durable generation queue.

`demoGuide/compose` is available to an already-admitted member under the gateway's read capability.
It has no payment or owner-action capability. It incurs inference usage: one request at a time
and at least ten seconds between starts per agent process. This is neither a per-member quota nor
a distributed limiter. It does not count as a money-path intervention. Existing gateway membership,
host scope and request-size checks still apply.

The model receives the question and UI mode/stage/instance-role only. No balances, invoices, agent
identifiers, payees or signing payloads are automatically attached. User-entered question text is
sent to inference, so users should not enter secrets. Mode/role are client observations, never
provider evidence. There is no persisted prompt, generated-scene or simulation store.

## Configuration and evidence

The agent process needs `NEARAI_API_KEY` for AI composition, using the existing model and attestation
policy in `src/llm.ts`. Without it, questions return an explicit unavailable result and the scripted
demo remains usable. No new dependencies, state migration or deployment are required to test the
scripted flow locally. Deployments remain the owner's action.

Offline coverage: `test/payables-guide.test.ts` checks schema rejection, transition boundaries,
AG-UI compatibility, verification before parsing, verification timeout and capability isolation.
The retired `test/browser/payables-player.cjs` covered desktop/mobile playback, pause, takeover, rewind, rejection,
unknown outcomes, mocked AI composition, invalid and stale response rejection, reload, and separation
from the mounted live controls. Existing walkthrough suites retain the live confirmation tests.

Live NEAR AI Cloud generation for this feature has not been exercised. A verified model response
does not establish the accuracy of its explanation. The new demo has not been deployed or observed
on mainnet; real payment execution is outside this change. General autonomous orchestration across
all three walkthroughs, AI-written signing payloads, simulated-to-live record conversion and a
public interactive demo are not implemented.

References: [AG-UI generative UI proposal](https://docs.ag-ui.com/drafts/generative-ui) (draft,
pattern rather than a built-in SDK capability), [NEAR AI verification](https://docs.near.ai/verification).
This implementation uses our bounded catalog; it does not claim A2UI protocol compatibility.

## Signing across the three walkthroughs

`web/src/features/demo/signing-walkthrough.tsx` supplies four authored chapters for each short and
complete walkthrough. Treasury covers mandate, plan, execution and outcome; Payables covers
agreement, request, decision and outcome; Invoices covers isolated order creation, supplier intake,
payment and reconciliation. Each explains the Agent API, OutLayer and NEAR Intents responsibilities
and the workflow’s relevant evidence limits.

Policy, strategy and agreement reviews mount only when explicitly opened and remain mounted when
the chapter changes. The existing components own permissions, exact payload preparation, wallet
signing, DAO proposal/vote tracking and error recovery. Chapter buttons only change explanation or
focus existing controls; they never execute an RPC mutation. Invoice owner-action history is accessed
inside the selected work order; it must not use the parent payout agent’s history. Opening a separate
route or reloading still uses the existing recovery behavior and does not restore an inferred selection.

`test/browser/signing-walkthrough.cjs` exercises wallet and DAO grant authorization through the
walkthrough with an injected offline wallet, exact prepared-message preservation, chapter navigation,
draft retention and entry without writes. The shared live-demo regressions retain payment and plan
confirmation, permission, stale-observation and outcome checks. These are offline observations;
no live signatures, funds, deployments or new provider-enforcement claims are part of this change.
Generative narration currently remains limited to the Payables player; the other chapter guides are authored.
