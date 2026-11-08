import { AppConsents, AppCredentials, MAX_REQUESTS_PER_HOUR, sweepConsentKeys } from "./gateway/app-access.js";
import { chainKeyState } from "./signin.js";

// Run in the gateway's directory, where `.app-access/` lives. Operator only; the token prints once.
//   pnpm app-credential issue <deployment> <host> [days=90] [label] [--per-hour <n>]   (default 1,200 requests an hour)
//   pnpm app-credential list
//   pnpm app-credential limit <credential id> <requests an hour>   (in place; the token stays)
//   pnpm app-credential revoke <credential id>
//   pnpm app-credential consents [deployment]
//   pnpm app-credential revoke-consent <consent id>   (permanent, even if the record was archived)
//   pnpm app-credential check-keys   (revokes consents whose signing key the chain reports removed)
//   pnpm app-credential archive-consents   (moves records of consents ended over 30 days ago to consents-ended/)
const credentials = new AppCredentials(".app-access"), consents = new AppConsents(".app-access");
const [command, ...rest] = process.argv.slice(2);

if (command === "issue") {
  const flag = rest.indexOf("--per-hour"), perHour = flag === -1 ? undefined : Number(rest[flag + 1]);
  const [deployment, host, days = "90", ...label] = flag === -1 ? rest : [...rest.slice(0, flag), ...rest.slice(flag + 2)];
  if (!deployment || !host || (flag !== -1 && rest[flag + 1] === undefined))
    throw new Error(`Usage: pnpm app-credential issue <deployment> <host> [days=90] [label] [--per-hour <1-${MAX_REQUESTS_PER_HOUR}>]`);
  const { credential, token } = credentials.issue({ deployment, host, days: Number(days), label: label.join(" ") || `${deployment} app`, perHour });
  console.log(`Issued ${credential.id} for ${credential.deployment} on ${credential.host}, ${credential.perHour} requests an hour, expires ${new Date(credential.expiresAt).toISOString()}`);
  console.log(`Token (shown once; store it as the app's server secret):\n${token}`);
} else if (command === "list") {
  const all = credentials.list();
  for (const c of all) console.log(`${c.id}  ${c.deployment}  ${c.host}  ${c.perHour}/h  expires ${new Date(c.expiresAt).toISOString()}${c.revoked ? "  revoked" : ""}  ${c.label}`);
  if (!all.length) console.log("No app credentials.");
} else if (command === "limit") {
  const [id, perHour] = rest;
  if (!id || perHour === undefined) throw new Error(`Usage: pnpm app-credential limit <credential id> <1-${MAX_REQUESTS_PER_HOUR}>`);
  if (!credentials.limit(id, Number(perHour))) throw new Error("No such credential");
  console.log(`${id}: ${Number(perHour)} requests an hour from its next call`);
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
} else if (command === "archive-consents") {
  const moved = consents.archive();
  console.log(`Archived ${moved.length} ended consent record(s) to .app-access/consents-ended/.`);
} else if (command === "check-keys") {
  const { checked, revoked, unanswered } = await sweepConsentKeys(consents, chainKeyState);
  console.log(`Checked ${checked} live consents; revoked ${revoked.length}; ${unanswered.length} unanswered (check again).`);
  for (const id of revoked) console.log(`revoked ${id}`);
  for (const id of unanswered) console.log(`unanswered ${id}`);
  if (unanswered.length) process.exitCode = 1;
} else throw new Error("Usage: pnpm app-credential issue|list|limit|revoke|consents|revoke-consent|check-keys|archive-consents");
