# Treasury order cross-repository acceptance

This explicit offline gate starts the actual platform gateway and Treasury app server against the platform E2E's simulated provider, chain, owner key, and funds. It tests owner-signed policy and strategy grant, Treasury-only versus `treasury-orders` consent, exact order signature, placement, partial fill, fully filled but unpaid state, final payout, and lost placement/cancellation replies across app restarts. It does not show deployed provider support or move live funds.

Run with Node 24, a frozen platform candidate snapshot, and an installed clean Treasury checkout at the signed consumer commit. The snapshot supplies the installed dependencies and built platform web; the runner compares its dependency fingerprint with the snapshot record. The app driver compares every installed SDK package file with the vendored tarball.

```bash
CROSSREPO_SDK_GIT=/Users/jlwaugh/agencies/dao/sdk \
CROSSREPO_PLATFORM_COMMIT=<final-platform-commit> \
CROSSREPO_APP_ROOT=/path/to/clean/treasury/worktree \
CROSSREPO_APP_HEAD=<full-signed-treasury-commit> \
CROSSREPO_SDK_SHA=<vendored-sdk-tarball-sha256> \
CROSSREPO_DEPENDENCY_SNAPSHOT=/path/to/frozen/platform/stack-snapshot \
bash test/cross-repo/treasury-orders/run.sh
```

`run.sh` archives the exact platform commit into a fresh `/private/tmp` directory, applies only `fixtures.patch` to the provider simulator and test controls, and starts the E2E stack with its process-wide non-loopback network guard. It refuses a stale fixture patch. The runner hashes every other archived platform file against Git, checks loopback endpoints, records the installed dependency fingerprint and test-file hashes, and stops the stack after success or failure. The script prints the result manifest path; inspect `result.json` and `stack.log` there. The test is separate from the default candidate E2E suite because it requires a separate signed Treasury source and vendored package identity.
