# Developer access: getting an app credential

How a developer gets a service credential (`tap_…`) for an app deployment, and how it's rotated and revoked. Until
self-registration exists, the platform operator issues each credential by hand. This page is the process both sides
follow. Status: staging only (api.dev.multiagency.ai); production (api.multiagency.ai) isn't set up yet.

## Before asking: build on the local stack

No credential is needed to build. The platform repository's local stack issues one at startup:
`pnpm test:e2e:stack --treasury --app <deployment> --no-browser`. It runs the real gateway and agent servers with a
simulated provider, chain and wallet, so nothing touches real funds. The package README's quickstart runs against it.
Ask for a hosted credential once your app works there.

## What to send

Open an issue with the **App credential request** template (`.github/ISSUE_TEMPLATE/app-credential.md`). Never put a
secret in it. It asks for:
- **Deployment id:** `<publisher>-<app>`, lowercase letters, digits and dashes, at most 32 characters (for example
  `acme-payroll`). It's the name owners see in the consent text they sign, so it must not imitate another app or the
  platform; the operator reserves `multiagency-*` (a check by hand, not enforced in code).
- **Display name and website:** what the app is called and where owners can learn about it.
- **Domain proof:** a file at `https://<your domain>/.well-known/multiagency.txt` containing one line,
  `deployment=<deployment id> account=<your NEAR account>`. Owners will be shown this domain once consent pages show
  verified domains; until then the operator checks it by hand.
- **Your NEAR account:** the account that answers for the deployment.
- **Host:** staging first. A production credential follows only once production exists and your app has run on staging.
- **Scopes you'll ask owners for** (`read`, `owner`, `payout`, `treasury`, `treasury-execute`), and whether you'll ask
  DAO owners.
- Nothing private: the issue is public. The operator contacts you through your GitHub account to arrange delivery.

## What the operator checks and does

1. The deployment id is unique, follows the format and doesn't imitate another app or the platform.
2. The domain proof answers over HTTPS with exactly that deployment id and account.
3. The requested scopes fit what the app says it does.
4. Issue the credential on the requested host, for at most 90 days, from the gateway's state directory
   (`app-credential issue <deployment> <host> <days> "<display name>"`; see [platform staging](platform-staging.md),
   step 5).
5. Arrange delivery with the requester through their GitHub account, and deliver the token privately: never in the
   issue, a URL or a log. Close the issue with the credential id and expiry only.

## Your side

- **Keep it server-side.** The credential is a bearer secret for every consent your deployment holds: never send it to
  a browser, and keep it out of URLs, logs and source control. `appClient({ base, credential })` adds it to each call.
- **Limits:** 1,200 requests an hour per credential, shared by every owner of the deployment. Over it, calls answer
  `rate_limited` with `retryAfterSeconds`.
- **Rotation:** before it expires, ask for a new one (comment on the closed issue or open a new one). Both work until
  you switch; then ask for the old one to be revoked.
- **Revocation:** ask the operator at once if a credential may be exposed (`app-credential revoke <id>`). The operator
  also revokes a credential that's abused or whose domain proof disappears. Revoking a credential doesn't revoke owners'
  consents; owners revoke those, and a new credential for the same deployment acts under them again.

## What isn't built yet

Self-registration with a wallet, self-issued sandbox and staging credentials, limits per deployment, owner-facing
verified domains, a hosted sandbox and production app access. The plan and its order are in the workspace's
`coordination/self-serve-developers-plan.md`.
