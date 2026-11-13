# Owner-signed Market funding allocation

Unreleased, offline-tested candidate. Not deployed or mainnet-observed. It prepares and records permission;
it does not send funds. The existing Market hire path still performs every submission through dispatch.

The owner may allocate a fully proven, isolated funding-only observation to one exact hire. The source
binding retains `fundingOnly: true` permanently. A single append-only journal record creates the target
binding and reserves the source credit only to that target. It cannot clear legacy funding, convert the
observation into a hire, replace the key, or generally release its funds. Native remainders remain reserved.
The initial version requires both source stages proven and full USDC delivery; short-delivered sources,
DAO reservations, unexplained balances, used nonces and missing receipt evidence refuse.

The owner's NEP-413 signature uses `multiagency.market-funding-disposition.v1`, recipient the explicitly
configured platform host. It binds the provider origin, current wallet owner/key, provider agent, original
payment key, source binding and final receipt references, exact source credit, maximum additional USDC
top-up, target actor/request ID/brief/price/payee/asset/window, current policy revision/digest, nonce and
expiry. This is the platform's permission record, not a provider grant or provider enforcement of allocation.

Before recording, the executor re-proves the original destination receipts, checks a later final chain view
against the accounted credits and unused key, and checks current ownership, FullAccess signing authority
and the applied policy. Dispatch repeats owner/key, policy and expiry checks for each new send. These are
local preconditions against remote observations, not atomic fencing of a later remote change. The full hire
price still must fit policy; a provider grant and an app's `market` consent remain separate requirements.

The additional USDC top-up cannot exceed the signed ceiling. An allocated hire cannot request another
native opening withdrawal. The allocation deadline also constrains delegate signing and paid-call retries
through the existing approval-deadline path. Expiry never permits another send. An attempted unknown
payment remains poll-only; status reads can reconcile earlier funding without fresh spending permission.

An owner can renew authority for the same immutable source and target before any payment operation is
recorded, signing a fresh nonce, expiry and reviewed policy. The signing key may change only if the new
key currently has FullAccess on the same owner account. A changed target, quote or top-up ceiling requires
separate recovery work; this candidate provides no arbitrary retargeting, cancellation, return or sweep.
Successful payment still does not generally release residual funds for another request.

## Private operator workflow

Use the canonical original executor/state/settings, with no other writer. Configure
`MARKET_ALLOCATION_HOST` explicitly in that agent's preserved hosted settings during the stopped-executor
rollout; there is no fallback to a host supplied by a caller. Missing configuration refuses allocation.
Deployment, settings changes, owner signatures, funds and hires need their own scoped approvals.

Prepare a private JSON review containing the allocation message fields except `domain` and `nonce`.
Choose the target only after reviewing an exact current Market quote; public catalog pricing is insufficient.
The review includes `maxTopUpUsdc`; do not assume route fees are zero or enlarge this ceiling automatically.
From the canonical state cwd, using absolute code and settings paths:

```sh
ENV_FILE=/data/state/.hosted/REVIEWED.env \
  /app/node_modules/.bin/tsx /app/scripts/market-allocation.ts prepare /private/allocation-review.json
```

The owner signs the returned `message`, `nonce` and `recipient` unchanged. Keep the four signed fields
`message`, `nonce`, `publicKey`, `signature` in a private file. Commit or inspect that same identity:

```sh
ENV_FILE=/data/state/.hosted/REVIEWED.env \
  /app/node_modules/.bin/tsx /app/scripts/market-allocation.ts commit /private/signed-allocation.json
ENV_FILE=/data/state/.hosted/REVIEWED.env \
  /app/node_modules/.bin/tsx /app/scripts/market-allocation.ts status /private/signed-allocation.json
```

These commands never hire, create a grant, sign a payment or clear a reservation. `status` reports retained
journal state, not fresh authority. Repeat admission of the identical current signature is idempotent;
an older superseded nonce cannot be replayed. After a lost reply, inspect the retained allocation and exact
target before continuing. Do not replace its request ID or issue another paid call to work around uncertainty.
The actual hire remains separately authorized and uses its existing quote, policy/grant checks, journal,
money lock, local exact payment signer and final chain reconciliation.

## Evidence and compatibility

`test/market-allocation.test.ts` checks exact signatures, source/target immutability, replay, redacted history,
the pinned pre-allocation reader, real-process contention and SIGKILL before/after the append with real
stale-lock recovery. `test/market-hire.test.ts` covers the exact target through dispatch, top-up limits,
owner/key/host/policy/receipt/balance/nonce changes, DAO refusal and expiry during signing. Existing
funding-only, unknown-outcome, deadline and one-send-site tests remain applicable.

The new `market-allocation` journalVersion 4 record is additive; existing records need no conversion or
directory creation. It is permission metadata, not a money operation. Previous strict readers refuse it
rather than ignore it. Public journal export reports a metadata gap and omits its private signed terms.
Follow the [stopped-executor preservation procedure](operations.md#market-funding-allocation-candidate)
before adoption or rollback. No live allocation is established by these offline tests.
