# Contributing

This repository moves real funds on NEAR Intents mainnet. Read `CONTEXT.md` for its terms and `AGENTS.md` for the
rules every change keeps.

**Building an app?** Use `@multiagency/sdk` from npm, in your own repository. Don't copy the gateway, executor or
money path. If the SDK is missing something, open an issue describing what your app needs.

## Before you open a pull request

Open a pull request directly for docs, tests and anything not listed below.

Open an issue first, and wait for agreement, for changes to:
- the money path (the files listed in `AGENTS.md`);
- authorization: what a procedure, role, credential or scope allows (`src/contract/permissions.ts`, `src/gateway/`);
- the owner contract or SDK schemas (`src/contract/`);
- state formats (the directories in `docs/operations.md`).

A bug fix starts from a failing test or recorded evidence.

## Checks

Node 24.22+ and pnpm 12.15:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm evidence:check
```

Gateway, SDK and browser changes also run `pnpm test:e2e` (needs OpenSSL and `pnpm exec playwright install
chromium`). Never run `pnpm test:live`, and never use real keys or a `.env`.

## In your pull request

- One change, linked to its issue if it has one.
- What you ran, and what isn't covered.
- Docs say how each claim is known (tested offline, observed on mainnet with its date, per provider docs or source at a
  pinned commit, or unverified). Fix any claim your change makes untrue. Generated sections come from
  `evidence/inventory.ts`: edit that and run `pnpm evidence:write`, never the generated text.
- No local paths, transaction hashes, amounts or payees.
- You're responsible for everything you submit, including what an AI tool wrote.

## Security and license

Report vulnerabilities privately to contact@multiagency.ai, not in an issue. Everyone here follows the
[code of conduct](CODE_OF_CONDUCT.md).

This repository, including the SDK, is under the MIT License (`LICENSE`). By submitting a contribution, you agree to
license it under the same terms.
