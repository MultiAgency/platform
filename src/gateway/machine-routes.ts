import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BadRequest, readJson, sendJson as json } from "../http.js";
import { appendSynced } from "../synced.js";
import { hourlyLimit } from "../signin.js";
import type { AgentEntry } from "./config.js";
import { MachineCredentials, MachineIssue, machineMayCall } from "./machine-auth.js";
import { resolveMachineAccess, resolveMachineManagement } from "./machine-authority.js";
import { isIntervention } from "./allowlist.js";
import { forwardRpc } from "./rpc-proxy.js";

const credentials = new MachineCredentials(".machine-auth");
const mayUse = hourlyLimit(600);
/** Shared host routing selects the agents and session before entering this handler. */
export async function machineRoutes(req: IncomingMessage, res: ServerResponse, pathname: string,
  host: string, selected: AgentEntry[], sessionAccount: () => string | null, stopping: () => boolean): Promise<boolean> {
  const account = sessionAccount();
  if (pathname.startsWith("/machine/")) {
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined) {
      json(res, 403, { error: "Use a machine client without browser credentials." }); return true;
    }
    const call = pathname.match(/^\/machine\/v1\/a\/([a-z0-9-]+)\/rpc\/([A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*)$/);
    if (!call) { json(res, 404, { error: "Not found" }); return true; }
    if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
    const credential = credentials.authenticate(req.headers.authorization, host);
    if (!credential) { json(res, 401, { error: "Invalid, expired or revoked credential" }); return true; }
    if (!mayUse(credential.id)) { const after = mayUse.retryAfterSeconds(credential.id); json(res, 429, { error: "Request limit reached", retryAfterSeconds: after }, { "retry-after": String(after) }); return true; }
    const agent = selected.find(a => a.name === call[1] && a.area === "treasury");
    if (!agent || agent.name !== credential.agent || agent.owner !== credential.owner) {
      json(res, 403, { error: "Credential does not authorize this agent" }); return true;
    }
    const body = JSON.stringify(await readJson(req));
    const authority = await resolveMachineAccess(credential.account, agent);
    if (!authority || authority.agentId !== credential.agentId || !machineMayCall(credential.scopes, authority.access, call[2]!)) {
      json(res, 403, { error: "Current ownership, agent identity or permission could not be verified" }); return true;
    }
    if (stopping() || !credentials.authenticate(req.headers.authorization, host)) {
      json(res, 403, { error: "Access ended before forwarding" }); return true;
    }
    const entry = { at: new Date().toISOString(), account: credential.account, owner: agent.owner,
      host, agent: agent.name, agentId: authority.agentId, path: call[2], machineCredentialId: credential.id };
    appendSynced(join(".machine-auth", "access.jsonl"), entry);
    if (isIntervention(call[2]!)) { mkdirSync(".evidence", { recursive: true }); appendSynced(join(".evidence", "interventions.jsonl"), entry); }
    forwardRpc(req, res, agent, call[2]!, undefined, body, `machine:${credential.id}`);
    return true;
  }
  const route = pathname.match(/^\/gw\/machine-credentials\/([a-z0-9-]+)(?:\/([0-9a-f-]{36}))?$/);
  if (!route) return false;
  if (req.headers.authorization !== undefined) { json(res, 403, { error: "Use owner sign-in to manage access" }); return true; }
  if (!account) { json(res, 401, { error: "Sign in first" }); return true; }
  const agent = selected.find(a => a.name === route[1] && a.area === "treasury");
  // Restricting or inspecting authority uses the configured wallet owner and host-local session.
  // It deliberately needs no Treasury/provider observations; issuing or using authority does.
  if (!agent || !await resolveMachineManagement(account, agent)) { json(res, 403, { error: "Wallet owner access required. DAO machine delegation is unavailable." }); return true; }
  if (sessionAccount() !== account) { json(res, 401, { error: "Sign in again to manage access" }); return true; }
  const id = route[2];
  if (req.method === "GET" && !id) {
    json(res, 200, { credentials: credentials.list(agent.name, agent.owner).filter(c => c.host === host) }); return true;
  }
  if (req.method === "DELETE" && id) {
    if (!credentials.list(agent.name, agent.owner).some(c => c.id === id && c.host === host) || !credentials.revoke(id, agent.name, agent.owner))
      json(res, 404, { error: "No such credential" });
    else json(res, 200, { revoked: true });
    return true;
  }
  if (req.method === "POST" && !id) {
    const parsed = MachineIssue.safeParse(await readJson(req));
    if (!parsed.success) throw new BadRequest("Choose a label, permissions and a duration between one minute and 24 hours.");
    const authority = await resolveMachineAccess(account, agent);
    if (!authority) { json(res, 409, { error: "Fresh wallet ownership could not be verified. DAO machine delegation is unavailable." }); return true; }
    if (sessionAccount() !== account) { json(res, 401, { error: "Sign in again before authorizing access" }); return true; }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping" }); return true; }
    json(res, 201, credentials.issue({ ...parsed.data, account, owner: agent.owner, agent: agent.name, agentId: authority.agentId, host }));
    return true;
  }
  json(res, 405, { error: "Use GET or POST on access, or DELETE on an existing credential" }); return true;
}
