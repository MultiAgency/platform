# @multiagency/sdk changes

Every SDK change appends a note under the next version's heading when it is made: what changed for the apps, and any
wire change all apps must update for together. The first change after a release moves `package-version.ts` to the next
version, so a package staged or packed from changed sources never carries a released version's number. The release
candidate dates the heading. Under 0.x, any public-interface change bumps at least the minor version.

## 0.3.1 (not released)

No code, type or wire change.

- **License: MIT** (copyright MultiAgency LLC).
- **README:** "What the platform does for your product": what the provider does, what the platform guarantees to an
  app and what the app still does, and what has run where for each client's routes.
- **app-server skill:** the platform's host serves only `/apps/v1` and the confirm page (no sign-in or owner page), and
  setup there is for Payables agents only. A vote the platform can't verify is refused before anything reaches the
  provider (`refused`, code `local_authorization_held`).

## Earlier versions

0.0.1 to 0.3.0: see the [changelog at sdk-v0.3.0](https://github.com/MultiAgency/platform/blob/sdk-v0.3.0/docs/sdk-changes.md).
