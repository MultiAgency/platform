import { AppConsents, AppCredentials, sweepConsentKeys } from "./gateway/app-access.js";
import { chainKeyState } from "./signin.js";

// Run in the gateway's directory, where `.app-access/` lives. Operator only; the token prints once.
//   pnpm app-credential issue <deployment> <host> [days=90] [label]
//   pnpm app-credential list
//   pnpm app-credential revoke <credential id>
//   pnpm app-credential consents [deployment]
//   pnpm app-credential revoke-consent <consent id>   (permanent, even if the record was archived)
//   pnpm app-credential check-keys   (revokes consents whose signing key the chain reports removed)
const credentials = new AppCredentials(".app-access"), consents = new AppConsents(".app-access");
const [command, ...rest] = process.argv.slice(2);

if (command === "issue") {
  const [deployment, host, days = "90", ...label] = rest;
  if (!deployment || !host) throw new Error("Usage: pnpm app-credential issue <deployment> <host> [days=90] [label]");
  const { credential, token } = credentials.issue({ deployment, host, days: Number(days), label: label.join(" ") || `${deployment} app` });
  console.log(`Issued ${credential.id} for ${credential.deployment} on ${credential.host}, expires ${new Date(credential.expiresAt).toISOString()}`);
  console.log(`Token (shown once; store it as the app's server secret):\n${token}`);
} else if (command === "list") {
  const all = credentials.list();
  for (const c of all) console.log(`${c.id}  ${c.deployment}  ${c.host}  expires ${new Date(c.expiresAt).toISOString()}${c.revoked ? "  revoked" : ""}  ${c.label}`);
  if (!all.length) console.log("No app credentials.");
} else if (command === "revoke") {
  const [id] = rest;
  if (!id || !credentials.revoke(id)) throw new Error("No such credential");
  console.log(`Revoked ${id}`);
} else if (command === "consents") {
  const all = consents.list({ deployment: rest[0] });
  for (const c of all) console.log(`${c.id}  ${c.deployment}  ${c.host}  ${c.organization}  ${c.owner}  ${c.agent}  ${c.scopes.join(",")}  expires ${new Date(c.expiresAt).toISOString()}${c.revoked ? "  revoked" : ""}`);
  if (!all.length) console.log("No app consents.");
} else if (command === "revoke-consent") {
  const [id] = rest;
  if (!id || !consents.revoke(id, null)) throw new Error("Not a consent id");
  console.log(`Revoked consent ${id}`);
} else if (command === "check-keys") {
  const { checked, revoked, unanswered } = await sweepConsentKeys(consents, chainKeyState);
  console.log(`Checked ${checked} live consents; revoked ${revoked.length}; ${unanswered.length} unanswered (check again).`);
  for (const id of revoked) console.log(`revoked ${id}`);
  for (const id of unanswered) console.log(`unanswered ${id}`);
  if (unanswered.length) process.exitCode = 1;
} else throw new Error("Usage: pnpm app-credential issue|list|revoke|consents|revoke-consent|check-keys");
