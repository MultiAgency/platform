---
name: App credential request
about: A service credential (tap_…) for your app deployment on a hosted platform. Never put a secret here.
labels: app-credential
---

See docs/developer-access.md for the process. Build on the local stack first; it needs no credential.

**Deployment id** (`<publisher>-<app>`, lowercase, at most 32 characters):

**Display name:**

**Website:**

**Domain proof:** `https://<your domain>/.well-known/multiagency.txt` contains `deployment=<deployment id> account=<your NEAR account>`
- [ ] It's in place

**Your NEAR account:**

**Host:** staging (api.dev.multiagency.ai) / production (not available yet)

**Scopes you'll ask owners for** (`read`, `owner`, `payout`, `treasury`, `treasury-execute`), and whether you'll ask DAO owners:

**What the app does for owners** (a few sentences):

This issue is public: don't post an email or any secret. The operator contacts you through your GitHub account to deliver
the credential privately.
