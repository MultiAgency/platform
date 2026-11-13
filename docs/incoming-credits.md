# Incoming confidential credits

Recipient-agent execution history is not a complete incoming-transfer ledger. A payment from another confidential treasury can increase the provider balance without appearing in that recipient's `getHistory`, wallet audit or deposit records. An unrecorded positive residual means **incoming history incomplete**; it does not establish missing funds or agent malfunction. Public drift and a confidential balance below recorded funds remain distinct mismatch evidence. Matching recorded balances is not independent custody proof.

## Evidence and trust

`reconcileBooks` adds immutable incoming-credit evidence to successful execution flows, without changing the execution journal or sending funds. Its optional metadata reports execution-recorded and incoming-recorded totals, receipt provenance, and `matched`, `history-incomplete` or `balance-mismatch` status. Existing raw-unit fields remain compatible. Old state needs no conversion; without credits, the recorded total stays unchanged.

Prefer a provider operation ID: the import reads its status and requires `SUCCESS`, confidential transfer terms naming the exact recipient, asset and atomic amount, and settlement intent evidence. A known ID with failed, unavailable or contradictory evidence refuses, including when `--attest-receipt` is supplied. This is provider-reported evidence, not independent chain proof; see the provider's [receipt semantics](https://docs.agentsonintents.com/integration/agent-api/receipts). No provider operation or receipt request that sends money is used.

When the provider exposes no incoming operation ID, an operator may explicitly attest an existing funding receipt. This is an accounting assertion by a trusted state operator, **not a verified provider receipt or a new owner signature**. Review the original receipt for executed status, exact recipient, asset, amount, date, issuer and durable receipt identity. A proposal signature, matching amount, or balance alone is insufficient. The command binds the recipient to the provider agent's wallet. Do not import credentials or signing material as receipts.

The exact receipt bytes, their SHA-256, normalized terms, actor, recording time and record checksum are retained in owner-only, create-once files under `.evidence/incoming-credits/<agent-hash>/`. Checksums detect accidental alteration; they do not protect against a malicious operator who controls state. They are not cryptographic owner authorization. Preserve this directory with the existing `.evidence/` state and private backups. No existing state directories or files are replaced.

A repeated source receipt or shared provider correlation/intent identifier cannot add another credit. Changed evidence or conflicting terms refuses. Exact duplicate terms under another identity are refused for review rather than merged by similarity. Later execution history with a shared settlement identifier takes precedence, so it cannot credit the payment twice. When a receipt number alone cannot distinguish it from later provider credit history for that asset, reconciliation refuses the ambiguous overlap until the records can be bound. Do not assign a new receipt identity to evade this refusal.

## Operator procedure

Stop the selected agent's executor using the established operating procedure. Back up its settings, journal and `.evidence/` directory. Keep other agents isolated. This command takes the normal money lock but does **not** resolve or modify journal entries; unresolved operations refuse the import. `--executor-stopped` is the operator's attestation, not automated process-liveness proof. Running with no executor stopped is unsupported.

Prepare a private JSON file with synthetic-shaped fields:

```json
{
  "agent": "provider-agent-id",
  "recipient": "provider-wallet.near",
  "asset": "nep141:token.near",
  "amount": "1000000",
  "settledAt": "2026-01-01T12:00:00Z",
  "source": { "issuer": "https://receipt.example", "receiptId": "treasury:receipt-id" },
  "correlationId": "provider-operation-id"
}
```

`amount` uses atomic units, never a USD valuation. Include the actual settlement `intentHash` when known; never substitute a DAO signature payload hash. With a provider ID, the successful status supplies the settlement time and intent hash. When no provider ID exists, omit `correlationId`, retain the receipt's date and choose the explicit attestation path after review.

From the agent's **state working directory**, using the reviewed source and isolated `ENV_FILE`:

```sh
ENV_FILE=/absolute/agent.env node --import /absolute/platform/node_modules/tsx/dist/loader.mjs \
  /absolute/platform/src/record-incoming-credit.ts \
  --credit /private/credit.json --receipt /private/funding-receipt.pdf \
  --recorded-by operator-account --executor-stopped
```

Add `--attest-receipt` only for the receipt path without a provider ID. It never relaxes validation of a known provider ID. Retry an interrupted import with the same receipt and terms. Do not delete records, resend the payment, change an operation key, or edit the journal to make books match.

Re-read books. Require the exact expected incoming total, zero residual, valid receipt provenance and no unresolved operations. Treasury's hourly books cache may retain its prior hold until the next refresh. Restart only through the approved rollout procedure, then inspect the new watcher decision. Reconciliation does not itself approve, execute or enable autopilot; other policy, risk and pacing holds remain in force.

## Verification and limits

Offline tests cover persistence, unchanged legacy inputs, wrong recipient/asset/amount, duplicate and conflicting evidence, provider/receipt overlap, corruption, coverage versus shortfall, and the matched credited balance. No production credit has been entered by these tests. Automatic discovery of all outside confidential credits is not established: the pinned provider SDK has no typed incoming-credit feed. The provider-status import is preferred when an exact operation is available; manual attestation remains explicit.
