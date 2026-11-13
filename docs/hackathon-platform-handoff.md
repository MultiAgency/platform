# Treasury and Paperwork Platform handoff

For subsequent source/deployment divergence, feature gates and the current stabilization review,
see [the stabilization record](hackathon-stability.md). The frozen demo identities below remain
historical compatibility pins; they are not a claim about current hosted source.

Initial contract checked 2026-11-13 03:20 UTC. Deadline checked against
[official instructions](https://nearhackathon.com/HACKATHON.md): 2026-11-14 23:59 UTC,
44h39m remaining at that check. Freeze shared interfaces by 2026-11-14 17:59 UTC.
The rules permit independent projects with a shared founder; both READMEs must name the other
project and disclose shared infrastructure. Each has three members; the founder is the only overlap
(per the integration brief, not independently verified). Publication, deployment and submission remain
owner actions. Local-only demonstrations require a video and reproducible public source.

## Compatible contract

Both consumer checkouts were clean when inspected. No consumer files were edited.

| Component | Exact identity | Acceptance |
| --- | --- | --- |
| Platform for both demos | `252cba1d1e6642a5ea9f42ea4927f982423ed8e1` | observed: both consumer verifiers pin it |
| SDK | `0.5.9`, archive SHA-256 `4ae53dce669664bcf90e0c5939e0ac617db0ab24c101e3792fc659ac4494475a` | observed: both vendored archives match |
| Historical frozen candidate | `822346ac5b50313d493c951971695abbbab5cc1d5a48ca8868bc73421a609a40` | retained unchanged; public rebuild is a separate run |
| Treasury inspected source | `33236acd6528509f95aeb1844b1ef1c94b75c78e` | observed local checkout |
| Paperwork inspected source | `422eacfd6135db691f53ad1c774b1e30f270ce50` | observed local checkout |
| Current Platform editing base | `39eefe1` | documentation corrections only; does not replace the demo pin |

Do not repack this SDK identity, overwrite provenance, or counterfeit `SNAPSHOT.json`. New source
builds have fresh E2E manifests under `.test-artifacts/e2e/run-*`; they do not inherit the historical
candidate's build or dependency fingerprint. A necessary interface release requires a new explicit
identity and acceptance from both teams. No such release is proposed here.

## Public bootstrap

Use Node **24.22.3**, pnpm **12.15.0** for Platform; OpenSSL on PATH. Treasury uses pnpm
**12.16.1**; Paperwork uses Bun **1.4.2**. Install Playwright's pinned Chromium only for browser checks.
Use a new checkout and empty runtime state; no `.env`, private snapshot or provider credentials are needed.

```sh
git clone https://github.com/MultiAgency/platform.git platform-demo
cd platform-demo
git checkout --detach 252cba1d1e6642a5ea9f42ea4927f982423ed8e1
pnpm install --frozen-lockfile
pnpm build:web
```

Run **one stack at a time on this machine**: hosted agents reserve ports from 9000. Separate fresh
runs isolate state but do not isolate this shared port range. Retain logs on failures. Do not stop
another team's processes or reuse a stack after a demonstration has created records.

Treasury:

```sh
pnpm test:e2e:stack --app treasury-test --treasury --no-browser
```

Paperwork restart flow (no Market dependency):

```sh
pnpm test:e2e:stack --app multiagency-paperwork --no-browser \
  --owner acme.demo --payee maria.demo --builder attacker.demo
```

Paperwork combined app needs a **different fresh run**, with `--market` added to that command.
Each launcher prints `Isolated stack ready: <stack>/state.json`. This is service startup, not
consumer acceptance. Read that file for `app.base`, `app.deployment`, `app.credentialFile`,
`chain.rpc`, `treasury.agent` (`portfolio`) and optional `market.url`. `payout` is the default payout
agent. Hosted Organization agents retain their generated identities: never substitute `portfolio`
for an app's reserved agent. The generated credential is a 0600 file; never print its contents.

The certificate is `<stack>/environment/localhost.crt`. Keep verification enabled:

```sh
curl --fail --cacert "$STACK/environment/localhost.crt" "$APP_BASE/health"
```

Use `NODE_EXTRA_CA_CERTS="$STACK/environment/localhost.crt"` for Node app servers. Bun consumers
use the SDK's custom fetch with `tls.ca` as documented in the bundled app-server skill.
A gateway health response does not prove an agent child or provider ready: the actual consumer
setup/read/action and retained status checks are the acceptance gate.

Stop only this run by creating `<stack>/stop` (`touch "$STACK/stop"`). Wait for `Stack stopped`.
Keep its E2E manifest, observations and service logs for diagnosis. Credential files and raw
control/signature records are local artifacts, never submission receipts.

## Consumer commands and ownership

Treasury's `verifyPlatform` already accepts a Git checkout at the exact commit and checks runtime
source hashes. From Treasury, with `TREASURY_PLATFORM` pointing to the installed Platform checkout:

```sh
pnpm install --frozen-lockfile
pnpm verify:sdk
TREASURY_PLATFORM=/absolute/path/platform-demo pnpm --filter @treasury/server test:stack
TREASURY_PLATFORM=/absolute/path/platform-demo pnpm --filter @treasury/web test:stack
```

The tests own their stacks; stop a manually started stack first. Interactive startup configuration
is in Treasury's `docs/app-server.md`; the Treasury team owns the chosen interactive route and its
final acceptance. A passing API test alone does not establish interactive launch.

Paperwork's existing explicit-stack route avoids its author-local frozen-snapshot search without
weakening that verifier. From Paperwork, with the fresh stack's directory (not Platform's root):

```sh
bun install --frozen-lockfile
PLATFORM_STACK_DIR=/absolute/path/to/stack bun run demo:job:restart
```

For the combined app, supply a different fresh `--market` stack to `bun run demo:full` (interactive)
or `bun run demo:full:check` (browser acceptance). The caller owns stack cleanup. The launcher owns
its app processes and retains receipts; a rebuild must be described as a public-source rebuild,
not the historical frozen candidate. Paperwork owns its final selected route and acceptance.

## Capabilities used and evidence boundaries

All rows refer to the exact Platform/SDK pair above. Commands are consumer-repository commands
unless prefixed with Platform. Local settlement is simulated; source support is not hosted evidence.

| Capability | Enforcing component | Verification command | Observed result | Remaining limitation |
| --- | --- | --- | --- | --- |
| App credential, consent, scoped setup | gateway + fresh owner/DAO evidence | Treasury `pnpm --filter @treasury/server test:stack` | observed: DAO/setup/API checks passed; credential case rerun passed after ECONNRESET | no hosted consumer acceptance inferred |
| Treasury proposals, approval, execution and retained status | proposal service → plan → dispatch; provider enforces signed policy | same | observed: proposal execution and SIGKILL recovery checks passed | approval differs from settlement; single-host executor lease |
| DAO Payables setup, payout consent, payout grant and held-payout vote | gateway scope checks + agent provider-evidence verification + dispatch | Platform `pnpm test test/app-dao.test.ts`; Paperwork restart command above | observed: 71 focused Platform contract/client tests passed | local candidate, not deployed/mainnet-observed; no general DAO `owner` scope |
| Paperwork durable request and restart | app database + SDK request identity + Platform journal | Paperwork restart command above | observed: app SIGKILL/restart retained identities, then one simulated settlement | does not establish G14 recovery |
| Combined Paperwork Market hire | Market service + scoped consent + journal + simulated x402 | Paperwork combined browser command above | observed: builder settlement and separate listed-agent hire passed | rework blocked by missing non-execution proof; no deployed-market evidence |
| Lost provider response before correlation (G14) | journal safe halt | existing failing recovery check, see `docs/g14-provider-recovery.md` | unverified recovery; unsupported binding retained | provider owner must supply authenticated original-key → operation contract; no retry or budget release |

Production headless gateway hosting since 2026-11-07 is recorded in `docs/operations.md`; current
hosted SDK pairing, provider readiness and consumer execution were **unverified** in this work.
Source DAO Payables support corrects older wallet-only/Treasury-only wording; it does not expand
what any dated mainnet observation proves. No new live evidence is claimed or generated.

## Shared attribution for each submission

Suggested common statement: “This application uses the shared MultiAgency Platform and
`@multiagency/sdk` for app consent, owner/DAO signatures, guarded execution, durable request identity
and local simulation. Treasury and Paperwork are separate applications with one shared founder.
These primitives are shared work, not independently invented by both teams.”

Each team must add its own concrete application contribution and link the other project. Identify
pre-2026-10-19 baseline and the hackathon-window diff, per the official rules; this handoff does
not establish authorship or eligibility of every shared commit. Platform owns bootstrap and contract
issues; Treasury owns asset/cash UX and final reproduction; Paperwork owns work/review/compensation
UX and final reproduction. The founder need only resolve cross-team release exceptions or publication.

## Fresh-run receipts (2026-11-13 UTC)

These runs used exported tracked consumer source and a fresh Platform source tree with a new locked
install. Package caches were available; previous `node_modules`, runtime state, private credentials
and `SNAPSHOT.json` were not copied. Platform's Git object was obtained locally at the exact commit;
an anonymous public source archive download matched **all 1,177 files** against the tested checkout.
Archive SHA-256: `2302fbf6ea360bc4cbdb2259659e5842637eaed4b04a3092540e9fd25d6226e2`.
No full Git clone from GitHub was run; the public archive source equality was checked instead. Platform web build passed on Node 26.13.1;
stack snapshots rebuilt web on Node 24.22.3. Consumer checks used Node 24.22.3 / Bun 1.4.2.

| Acceptance item | Status | Visible outcome / limitation |
| --- | --- | --- |
| Public pin reachable anonymously | observed | entire anonymous public source archive matches tested source, 1,177 files |
| Fresh Platform frozen-lockfile install + build | observed | 465 dependencies installed, web build completed |
| Treasury stack startup | observed | `treasury-test`, `portfolio`, HTTPS `/health` returned `{"ok":true}` with generated CA verification |
| Paperwork stack startup | observed | `multiagency-paperwork`, required demo parties; no previous agents/transfers |
| Treasury API/DAO/setup/recovery batch | failed | 25 passed, one credential-rotation ECONNRESET, three existing TODOs; not a clean batch pass |
| Treasury credential-rotation isolated rerun | observed | one test passed on a new stack; original transient remains recorded |
| Treasury interactive browser suites | observed | 71 tests passed, zero failed/skipped/TODO; real app server + simulated provider/chain/wallet |
| Paperwork app-process restart | observed | same durable identities recovered after app SIGKILL; explicit approval then one confirmed simulated payment; no transaction hash |
| Paperwork combined browser demo | observed | builder terms, setup, report/invoice, explicit approval, processing then one simulated settlement; separate quoted Market hire delivered in the same app |
| Platform typecheck | observed | `pnpm typecheck` passed |
| Platform guarded offline suite | observed | direct Node 24 `node scripts/test.mjs offline`: 1,531 passed, zero failed/skipped; pnpm shim selected Node 26 in earlier stalled runs, which were stopped |
| Platform focused contract/client suite | observed | 71 passed, zero failed/skipped |
| Generated evidence drift | observed | checks passed; no generated requirement sections changed |
| Consumer team final acceptance | unverified | owners are in separate VS Code windows; these independent reproductions do not assert their approval |
| Current hosted consumer/provider execution | unverified | no authenticated hosted check, deployment, signature or real-funds action |

Local evidence (not portable submission dependencies): Platform stack manifests and observations
are under `/private/tmp/hackathon-platform-public/.test-artifacts/e2e/`, Treasury browser output
at `/private/tmp/hackathon-treasury-web.log`, credential rerun at
`/private/tmp/hackathon-treasury-credential.log`, full Platform tests at
`/private/tmp/hackathon-platform-tests-node24.log`. Paperwork restart launcher receipt:
`/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-restart-launch-s0CpIL/launcher-receipt.json`.
Combined browser launcher receipt:
`/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-full-launch-J1VDu4/launcher-receipt.json`;
output at `/private/tmp/hackathon-paperwork-combined.log`. All task-owned stacks were stopped through
their stop files. Raw local artifacts can contain test signatures and credentials; share only sanitized outcomes above.

The source correction in the SDK guides is not a newly released SDK. The vendored 0.5.9 guidance
retains its historical bytes; consumers should read this handoff alongside it until a coordinated
new release is needed. G14 investigation was not reopened: this demonstration loses an app reply
after durable proposal storage, not a provider reply before correlation capture.

Remaining demo boundaries: Paperwork's original submission path passed; SDK-simulator rework is
blocked by missing non-execution proof and must not be demonstrated as working. Paperwork owns
choosing that boundary in its walkthrough; a fix must first reproduce the specific rework blocker.
G14 remains provider-owned pending the supported original-request binding in the linked investigation.
Neither boundary justifies clearing unknown state or issuing a replacement payment. Further Platform
work requires a demonstrated blocker from the selected route. Both teams can use the commands above
without waiting for a shared interface release; their final acceptance remains theirs.
