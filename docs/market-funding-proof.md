# Controlled Market funding observation

This private owner-run tool prepares a proof of one current Market funding route without hiring an agent. It is not deployed or mainnet-observed. Offline coverage is in `test/market-hire.test.ts`; the production provider may omit destination receipt fields and leave funding in review.

`scripts/market-funding-proof.ts` calls `fundMarketOnly` in the same Market funding flow used by hires. Each withdrawal uses the same lock, request binding, stage identity, dispatch, authorization, mandate digest and final destination verifier. It does not request a Market quote, sign a delegate or make a paid call. A durable `fundingOnly: true` binding cannot become a hire; dispatch and journal replay reject an x402 operation for it. Landed funds stay reserved, including after short delivery closes the binding. Successful accounting does not authorize reuse or recovery.

## Operator review

Use a separately reserved isolated payment key and wallet-owned Market agent whose owner-signed policy names only that key for withdrawals, with the intended assets, caps and budget. Preserve its private settings before any send; never replace an existing key. The review must name the canonical absolute `stateDirectory`, the original absolute `settingsFile` under its `.hosted/` directory, and `ownerAccount`. The CLI refuses another working directory before application imports, requires an explicit absolute `ENV_FILE` matching the reviewed settings, and requires existing canonical `.hosted/` and `.ops/` directories. It never creates a replacement state directory or changes cwd to make a review pass. An existing journal must be the canonical regular file.

Wallet ownership is established from the preserved hosted registry entry for that settings file and checked against the provider agent, not inferred from a missing `HOSTED_OWNER_KIND`. Missing, released, conflicting, non-Market or DAO reservations refuse. Runtime agent/key, saved settings, reviewed identity and provider owner must agree. These checks repeat under the money lock and before each withdrawal, including after provider reads. The review also pins `reviewedPolicy` (revision and mandate digest) and `reviewedGrant` (grant ID and exact expiry). Dispatch compares the reviewed policy with its own fresh observation and rejects a different live grant before submission; later provider reads cannot silently replace the reviewed mandate. These are local preconditions against provider observations, not atomic fencing of a later remote policy or grant change; the operator must avoid concurrent policy/grant changes during the observation.

The new request needs a zero-USDC account, no used access-key nonce in the observed view, no earlier local binding and no legacy unbound funding. These local checks do not exclude an external signer or writer; the operator must establish exclusive use. DAO-owned agents are refused by this tool because it has no DAO-vote verification entry.

Review the exact provider origin, deployed source/image, agent, owner, policy, grant, payment account, request identity, deadline, amounts and recovery limits. Stop other writers for this agent before running; the lock is single-host, not distributed fencing. Do not run the script on a second host against copied journal state while the original executor remains active. No tool in this change deploys, restarts or generates a key.

The CLI caps its USDC withdrawal at 10000 base units (0.01 USDC with the token's confirmed six decimals). If opening is needed it also allows exactly 20000000000000000000000 wNEAR base units (0.02 NEAR). Registration on USDC must already be done by the owner, separately approved with its actual storage and gas costs. The withdrawal amount is not a total-cost ceiling. Below-minimum or fee-short delivery stops this attempt; never automatically increase its amount or create a new request.

A private JSON review file contains `stateDirectory`, `settingsFile`, `ownerAccount`, `actor`, `requestId`, `brief`, `approved`, `agentId`, `paymentAccount`, `providerOrigin`, `reviewedPolicy`, `reviewedGrant`, `approvalExpiresAt` (Unix milliseconds), `maxUsdc`, and `maxOpeningWnear`. `approved` uses the existing strict hire-terms envelope (`handle`, SHA-256 `brief`, `network`, `asset` contract, `payTo`, integer `amount`, `maxTimeoutSeconds`) for the shared funding authorization. In this tool those terms approve only the funding ceiling: no request goes to the handle and no payment goes to the payee. The approved amount must equal `maxUsdc`; the deadline must be live and at most one hour away. Preserve the reviewed file privately with exact identities; do not commit it.

Only after explicit review and live-funds approval, the owner runs the candidate's verified dependencies and isolated settings, for example:

```sh
cd /data/state
ENV_FILE=/data/state/.hosted/own-REVIEWED.env \
  /absolute/reviewed-candidate/node_modules/.bin/tsx \
  /absolute/reviewed-candidate/scripts/market-funding-proof.ts \
  /absolute/approved-review.json --execute
```

The paths above are placeholders for the approved executor host, reviewed candidate and preserved state. The platform package and image include `/app/scripts/market-funding-proof.ts`; its bytes are included in the release manifest. The offline image check loads that packaged command from a separate state working directory without credentials. The script and dependencies can live outside the state directory; invoke them by absolute path while staying in the reviewed canonical state directory. `ENV_FILE` alone does not select the journal or lock. Do not run this example from a source checkout or create an empty state directory to satisfy validation.

The provider credential and RPC configuration must already be available in that operator environment. `ENV_FILE` selects the agent's existing settings; it is not permission to create another executor. Run on the sole approved host with the canonical journal and all preserved state, never from this example against an arbitrary local copy.

## Evidence and stop conditions

Retain original requests/correlations and provider response provenance privately. A stage remains reserved unless provider SUCCESS includes `destination_tx_hash` and `amount_out`, the final receipt proves the exact recipient/asset/amount, and a later final chain view confirms the credit. The verifier also rejects reuse of one receipt for multiple stages. A final `funded` result establishes the recorded USDC stage's credit, not permission to hire or withdraw residual funds.

After a lost reply, provider uncertainty or missing/conflicting receipt, preserve `funding_review` and the original identities. Status reads (`hireStatus`) can reconcile exact original stages without submitting funds after approval expiry. A top-up-only retry with the original live approval can finish an unsubmitted next stage; it never resubmits a recorded stage. Do not invent a new identity to get around an unresolved operation. Old accounting and provider receipt recovery remain separate from the current-route observation.

## State preservation and rollback

The optional `fundingOnly: true` field is additive to Market v3 binding records. Existing bindings without it keep their previous hire semantics; no existing state needs conversion or directory creation. Preserve the canonical state directories listed in [operations](operations.md), the original settings, the private review and every journal/landing/reservation. No record may be dropped to make rollback succeed.

Earlier v3 readers use a strict binding shape and reject a funding-only record rather than pay it; pre-v3 readers also reject it. Such rollback is fail closed and is not a supported way to resume this agent. A stopped-executor recovery review must preserve the funding-only marker and reservations before selecting any reader. There is no automatic clearance, rotation or recovery in this change.
