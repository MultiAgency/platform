import { servePayeeFrontend } from "./payee-frontend.js";
import { accessFrontend } from "./access-frontend.js";
import { serveOwnerFrontend } from "./owner-frontend.js";
import { providedCapabilities } from "../contract/owner-capabilities.js";
import { resolveMachineManagement } from "./machine-authority.js";
import { machineRoutes } from "./machine-routes.js";
import { APP_ROOT, appRoutes, confirms } from "./app-routes.js";
import { confirmAssets, confirmRoutes } from "./app-confirm.js";
import { payeeBase, supplierCookie, supplierEnvironment, payeeRoute } from "./hosted-supplier.js";
import { demoHost, demoCrossSite, demoSession, invoiceRoute, assignedToHost } from "./demo-hosts.js";
import { forwardRpc } from "./rpc-proxy.js";
import { forwardInvoice } from "./invoice-proxy.js";
import { spawn } from "node:child_process";
import { Supervisor, workerArguments } from "./supervisor.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIntervention, mayCall } from "./allowlist.js";
import { BadRequest, crossSite, readJson, SECURITY_HEADERS, sendFailure, sendJson as json, serveStatic } from "../http.js";
import { chainKeyLookup, challengeAnswer, clientAddress, hourlyLimit, parseSignIn, sessions, verifySignIn } from "../signin.js";
import { type AgentEntry, childEnv, hostOf, loadConfig } from "./config.js";
import { recentSignProposals } from "./proposals.js";
import { ownerOf, resolveAccess, resolveAgentAccess } from "./roles.js";
import { appendSynced } from "../synced.js";
import { HostedAgents, authorizeSetup, hostedEnvironment, setupRequest, type HostedAgent } from "./hosted-agents.js";

/**
 * The hosted dashboard: the one public process. It signs members in, decides per request what each
 * may do from each agent's owner (a DAO's own policy, or the owner account itself), and forwards
 * allowed calls to the agent servers, which keep
 * running on loopback exactly as they do locally, each with its own agent, grant, lock and logs. The
 * gateway itself holds no grant token.
 */

const config = loadConfig();

/** The host serving each app area, so pages link to the full app on the same deployment (local or hosted). */

const appHosts = Object.fromEntries(Object.entries(config.hosts ?? {}).flatMap(([host, site]) => site.demo === "payables" || site.demo === "treasury" ? [[site.demo, host]] : []).reverse());
const hosted = new HostedAgents(".hosted", config.agents);
// Retain existing reservations even if new self-service setup is later disabled.
const agents = [...config.agents, ...hosted.list()];
const PORT = Number(process.env.PORT ?? 8800);
/** The host members sign in to; DASHBOARD_HOST overrides it, e.g. to test on a provider's domain before DNS moves. */
const HOST = hostOf(process.env.DASHBOARD_HOST || config.host);
/** Where the app is installed, apart from the working directory, which holds the agents' state. */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(APP, "web/dist");
/** On a headless host, the only files served beside the confirm page: its own assets. */
const HEADLESS_ASSETS = config.headless ? confirmAssets(DIST) : new Set<string>();
// Signs every session: an empty or missing secret would let anyone forge one, so the gateway won't start.
const SECRET = process.env.SESSION_SECRET ?? "";
if (SECRET.length < 32) throw new Error("Set SESSION_SECRET to a random value of at least 32 characters before starting the gateway");
const payeeHost = Object.entries(config.hosts ?? {}).find(([, site]) => site.demo === "invoices")?.[0];
const session = sessions({ cookie: "dao_session", secret: SECRET, secure: true });

const INTERVENTIONS = join(".evidence", "interventions.jsonl");
/**
 * Recorded interventions since `since`, oldest first, and the line numbers that don't parse. An
 * unreadable line may have been a call, so it is counted, not skipped: the report can't claim none.
 */
function interventions(since: string) {
  const calls: { at: string; account: string; agent: string; path: string }[] = [];
  const corrupt: number[] = [];
  const text = existsSync(INTERVENTIONS) ? readFileSync(INTERVENTIONS, "utf8") : "";
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try { calls.push(JSON.parse(line)); } catch { corrupt.push(index + 1); }
  }
  return { calls: calls.filter((i) => i.at >= since), corrupt };
}

/** The signed-in account and what it may do with each agent it may see, or null. */
async function viewer(req: IncomingMessage, auth = session, selected = agents) {
  const account = auth.account(req);
  if (!account) return null;
  const access = await resolveAccess(account, selected);
  return config.selfService || Object.keys(access).length ? { account, access } : null;
}

/** What this host's owner frontend may rely on: the neutral set plus its agents' and setup areas. Not authorization. */
function hostCapabilities(selected: typeof agents, site: { hostedAreas?: ("treasury" | "payables")[] }) {
  const areas = new Set([...selected.flatMap(a => a.area ? [a.area] : []), ...site.hostedAreas ?? []]);
  return providedCapabilities([...areas]);
}

/**
 * The agents a visitor may know of, each with its owner and whether that owner is a DAO (signing by
 * proposal): a signed-in viewer's own, or, signed out, only the DAOs' agents. Those are public already,
 * since every owner action is an on-chain proposal naming the agent; a wallet's agent is not.
 */
async function agentsView(me: Awaited<ReturnType<typeof viewer>>, selected = agents) {
  if (!me && (config.walkthroughs || config.hosts)) return [];
  const all = await Promise.all(selected.filter(a => !me || me.access[a.name]).map(async (agent) => ({ name: agent.name, owner: agent.owner, ...(agent.area && { area: agent.area }), ...("kind" in agent && { managed: true, invoices: agent.area === "payables" && payeeHost ? `https://${payeeHost}${payeeBase(agent.name)}/` : null }), ...(!("kind" in agent) && agent.invoices !== undefined && { invoices: agent.invoices }), dao: (await ownerOf(agent.owner)).policy !== null })));
  return all.filter((a) => (me ? Boolean(me.access[a.name]) : a.dao));
}

/**
 * Sign-in challenges per connecting address per hour. The global cap in signin.ts bounds memory;
 * this keeps one client from filling it and locking every member out of sign-in.
 */
const CHALLENGES_PER_HOUR = 20;
const mayChallenge = hourlyLimit(CHALLENGES_PER_HOUR);

let stopping = false;
const server = createServer(async (req, res) => {
  // On every answer: no other site may frame these pages (they trigger wallet signatures, so a hidden
  // frame could trick a click), types are taken as declared, no address leaks to linked sites, and
  // browsers keep to HTTPS once they have seen it.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    if (stopping) return json(res, 503, { error: "Gateway is stopping. Check existing records before retrying." });
    const url = URL.parse(req.url ?? "/", "http://gateway");
    if (!url) throw new BadRequest("Malformed request.");
    const { pathname } = url;
    // Health is public and contains no agent records, including on provider probe hosts.
    if (pathname === "/health" && ["GET", "HEAD"].includes(req.method ?? "")) return json(res, 200, { ok: true });
    // A headless host is the engine for apps: app access, the confirm page and the page's own assets. Nothing else
    // exists here, so no session is read and no other route answers, whatever else the web build contains.
    if (config.headless) {
      if (HEADLESS_ASSETS.has(pathname) && ["GET", "HEAD"].includes(req.method ?? "")) return serveStatic(res, DIST, pathname);
      if (!pathname.startsWith("/apps/") && !pathname.startsWith("/confirm/")) return json(res, 404, { error: "Not found" });
    }
    const site = config.hosts ? demoHost(req, config.hosts) : null;
    if (config.hosts && !site) return json(res, 421, { error: "Unconfigured demo host" });
    const signingHost = site?.host ?? HOST;
    const auth = site ? demoSession(SECRET, signingHost) : session;
    const selected = site ? agents.filter(a => assignedToHost(a, site)) : agents;
    if (site && demoCrossSite(req, signingHost)) return json(res, 403, { error: "Cross-origin request" });
    if (pathname.startsWith("/i/")) {
      const route = site?.demo === "invoices" ? payeeRoute(pathname) : null;
      const agent = route && selected.find(a => a.name === route.name && "kind" in a && a.area === "payables");
      if (!route || !agent) return json(res, 404, { error: "Contributor entry not found" });
      if (route.path === "/" && !["GET", "HEAD"].includes(req.method ?? "")) return json(res, 405, { error: "Use the invoice API" });
      if (req.method === "GET" && await servePayeeFrontend(res, route.path)) return;
      return forwardInvoice(req, res, `http://127.0.0.1:${agent.port}`, `/supplier${route.path}${url.search}`, request as typeof import("node:https").request, supplierCookie(agent.name));
    }
    if (site?.demo === "invoices" && (config.invoiceUpstream || pathname.startsWith("/invoice-ui/static/")) && req.method === "GET" && await servePayeeFrontend(res, pathname)) return;
    // Each app serves its own skill from its active release; there is no shared or fallback copy.
    if (site && pathname === "/skill.md" && ["GET", "HEAD"].includes(req.method ?? "")) {
      const served = site.demo === "invoices" ? await servePayeeFrontend(res, pathname)
        : site.frontend ? await serveOwnerFrontend(res, pathname, { ...site.frontend, provided: hostCapabilities(selected, site) }) : false;
      if (!served) json(res, 404, { error: "Not found" });
      return;
    }
    // Payee entry and retained work-order identities stay with the existing Payables executor.
    const intake = invoiceRoute(site?.demo, url, req.method ?? "");
    if (intake !== null) {
      if (!config.invoiceUpstream) {
        if ((pathname === "/" || pathname === "/submit") && ["GET", "HEAD"].includes(req.method ?? ""))
          return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contributor invoices · MultiAgency</title><main style="max-width:42rem;margin:4rem auto;padding:1.5rem;font:1.125rem/1.6 system-ui"><h1>Contributor invoices</h1><p>Open the contributor link shared by the owner to submit an invoice or track a purchase-order payment. Each owner has a separate entry.</p></main></html>');
        return json(res, 503, { error: "Use the contributor link shared by the owner" });
      }
      return forwardInvoice(req, res, config.invoiceUpstream, intake);
    }
    // State-changing requests must come from this site's own pages.
    if (req.method !== "GET" && crossSite(req)) return json(res, 403, { error: "Cross-site request" });

    if (pathname === "/health") return json(res, 200, { ok: true });

    if (!site && (pathname.startsWith("/machine/") || pathname.startsWith("/apps/") || pathname.startsWith("/confirm/") || pathname.startsWith("/gw/machine-credentials/") || pathname === "/gw/access-session")
      && req.headers.host?.toLowerCase() !== signingHost.toLowerCase()) return json(res, 421, { error: "Use the configured host for agent access" });
    if (await machineRoutes(req, res, pathname, signingHost, selected, () => auth.account(req), () => stopping)) return;
    if (await confirmRoutes(req, res, pathname, signingHost, confirms, APP_ROOT, selected, DIST, () => stopping)) return;
    if (await appRoutes(req, res, pathname, signingHost, selected, () => stopping, config.appSetup.length ? { setup: async ({ owner, area, deployment, organization }) => {
      if (!config.appSetup.includes(area) || (site && !site.hostedAreas?.includes(area))) throw new Error("This area is not available on this host");
      return reserveHosted({ owner, kind: "wallet", area }, { deployment, organization });
    } } : {})) return;
    // Anything under /apps/ or /confirm/ that neither answered: never the file server's pages.
    if (config.headless) return json(res, 404, { error: "Not found" });

    if (pathname === "/gw/challenge" && req.method === "GET") return json(res, ...challengeAnswer(signingHost, mayChallenge(clientAddress(req))));
    if (pathname === "/gw/session" && req.method === "POST") {
      const account = await verifySignIn(parseSignIn(await readJson(req)), signingHost, chainKeyLookup).catch((error: Error) => error);
      if (account instanceof Error) return json(res, 401, { error: account.message });
      const access = await resolveAccess(account, selected);
      if (!config.selfService && !Object.keys(access).length) return json(res, 403, { error: `${account} doesn't own any agent here, nor is a member of a DAO that does` });
      return json(res, 200, { account, access }, { "set-cookie": auth.open(account) });
    }
    if (pathname === "/gw/logout" && req.method === "POST")
      return json(res, 200, {}, { "set-cookie": auth.close() });

    // Access management must remain reachable during provider outages. This response grants no RPC access.
    if (pathname === "/gw/access-session" && req.method === "GET") {
      const account = auth.account(req);
      const candidates = account ? await Promise.all(selected.filter(a => a.area === "treasury").map(async a => {
        const management = await resolveMachineManagement(account, a);
        return management ? { ...a, dao: management.dao } : null;
      })) : [];
      const owned = candidates.filter(a => a !== null);
      return json(res, 200, { agents: owned.map(a => ({ name: a.name, owner: a.owner, area: a.area, dao: a.dao })),
        invoices: null, viewer: account ? { account, access: Object.fromEntries(owned.map(a => [a.name,
          { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: true }])) } : null,
        ...(site && { demo: site.demo }), walkthroughs: config.walkthroughs });
    }

    if (pathname === "/gw/me") {
      const me = await viewer(req, auth, selected);
      return json(res, 200, { agents: await agentsView(me, selected), invoices: config.invoices ?? null, viewer: me, ...(Object.keys(appHosts).length && { apps: appHosts }), ...(site && { demo: site.demo, capabilities: hostCapabilities(selected, site), setupAreas: config.selfService ? site.hostedAreas ?? [] : [] }), ...(config.walkthroughs && { walkthroughs: true }), ...(config.selfService && (!site || site.hostedAreas?.length) && { selfService: true }) });
    }

    if (pathname === "/gw/agents" && req.method === "POST") {
      const account = auth.account(req);
      if (!account) return json(res, 401, { error: "Sign in first" });
      if (!config.selfService) return json(res, 403, { error: "New agent setup is disabled on this host" });
      const parsed = setupRequest.safeParse(await readJson(req));
      if (!parsed.success) return json(res, 400, { error: "Choose a valid owner, owner type and area" });
      if (site && !site.hostedAreas?.includes(parsed.data.area)) return json(res, 403, { error: "This area is not available on this host" });
      try { authorizeSetup(account, parsed.data.kind, await ownerOf(parsed.data.owner)); }
      catch { return json(res, 403, { error: "Owner access could not be verified. Use your own wallet or a DAO where you can propose owner actions." }); }
      if (stopping) return json(res, 503, { error: "Gateway is stopping. No reservation was made." });
      return json(res, 200, { name: reserveHosted(parsed.data).name });
    }

    // A DAO's recent signing proposals, for a viewer who may see one of the agents it owns.
    if (pathname === "/gw/proposals") {
      const me = await viewer(req, auth, selected);
      if (!me) return json(res, 401, { error: "Sign in first", access: "session" });
      const dao = url.searchParams.get("dao") ?? "";
      const owned = selected.filter((a) => a.owner === dao && me.access[a.name]);
      if (!owned.length) return json(res, 403, { error: `No agent here you may see is owned by ${dao || "that account"}`, access: "procedure" });
      if (!(await ownerOf(dao)).policy) return json(res, 400, { error: `${dao} is not a DAO` });
      return json(res, 200, await recentSignProposals(dao, owned));
    }

    // Intervention history, including old operator records, for agents this viewer may execute or manage.
    if (pathname === "/gw/interventions") {
      const me = await viewer(req, auth, selected);
      const operated = new Set(Object.entries(me?.access ?? {}).filter(([, a]) => a.canExecute || a.canManage).map(([agent]) => agent));
      if (!operated.size) return json(res, me ? 403 : 401, { error: "Execution or management permission required", access: me ? "procedure" : "session" });
      const { calls, corrupt } = interventions(url.searchParams.get("since") ?? "");
      // An unreadable line can't be attributed to an agent, so every eligible viewer is told it exists.
      return json(res, 200, { calls: calls.filter((c) => operated.has(c.agent)), corrupt });
    }
    // Every gateway path is listed above; anything else under /gw/ is no page either.
    if (pathname.startsWith("/gw/")) return json(res, 404, { error: "Not found" });

    const call = pathname.match(/^\/a\/([a-z0-9-]+)\/rpc\/(.+)$/);
    if (call) {
      const agent = selected.find((a) => a.name === call[1]);
      if (!agent) return json(res, 404, { error: "No such agent" });
      const account = auth.account(req);
      if (!account) return json(res, 401, { error: "Sign in first", access: "session" });
      const access = await resolveAgentAccess(account, agent);
      if (stopping) return json(res, 503, { error: "Gateway is stopping. Check existing records before retrying." });
      if (!access) return json(res, 403, { error: `${account} may not see the ${agent.name} agent`, access: "agent" });
      if (!mayCall(access, call[2]!)) return json(res, 403, { error: "This account does not have permission for this action", access: "procedure" });
      // Preserve which calls count as interventions: recorded before they run, or not run.
      if (isIntervention(call[2]!)) {
        try {
          mkdirSync(".evidence", { recursive: true });
          appendSynced(INTERVENTIONS, { at: new Date().toISOString(), account, agent: agent.name, path: call[2] });
        } catch {
          return json(res, 503, { error: "The action could not be recorded, so it was not run" });
        }
      }
      return forwardRpc(req, res, agent, `${call[2]!}${url.search}`, undefined, undefined, account);
    }

    const scoped = pathname.match(/^\/a\/([a-z0-9-]+)(?:\/|$)/);
    if (site && scoped && !selected.some(a => a.name === scoped[1])) return json(res, 404, { error: "Agent is not assigned to this demo" });
    if (site && !["GET", "HEAD"].includes(req.method ?? "")) return json(res, 405, { error: "Not a submission endpoint" });
    // An owner app's own release serves presentation; consent stays Proto's, and unknown assets fall back to its chunks.
    if (site?.frontend && !/^\/a\/[a-z0-9-]+\/access\/?$/.test(pathname)) {
      if (await serveOwnerFrontend(res, pathname, { ...site.frontend, provided: hostCapabilities(selected, site) })) return;
      if (!pathname.startsWith("/static/")) return json(res, 404, { error: "Not found" });
    }
    return serveStatic(res, accessFrontend(site?.frontendDist, DIST, pathname), pathname.replace(/^\/a\/[a-z0-9-]+/, "") || "/");
  } catch (error) {
    sendFailure(res, error);
  }
}).listen(PORT, () => console.log(`Dashboard for ${config.agents.map((a) => `${a.name} (${a.owner})`).join(", ")} on port ${PORT}, signing in to ${HOST}`));

const supervisor = new Supervisor((agent: AgentEntry & { envFile: string }) => {
  const managed = "kind" in agent ? agent as HostedAgent : undefined;
  const environment = managed ? { ...hostedEnvironment(managed, process.env), ...supplierEnvironment(managed, payeeHost, SECRET) } : childEnv(agent);
  return spawn(process.execPath, workerArguments(...(managed ? [] : ["--env-file-if-exists=.env"]), join(APP, "src/server.ts")), {
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  });
});
/** Reserves (or finds) a hosted agent and starts its process once. Callers check who may set it up. */
function reserveHosted(...input: Parameters<HostedAgents["reserve"]>) {
  const reserved = hosted.reserve(...input);
  if (!agents.some(a => a.name === reserved.name)) { agents.push(reserved); start(reserved); }
  return reserved;
}

function start(agent: AgentEntry & { envFile: string }) {
  supervisor.start(agent);
}
for (const agent of agents) if (agent.envFile) start({ ...agent, envFile: agent.envFile });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const drained = new Promise<void>(resolve => server.close(() => resolve()));
    const deadline = setTimeout(() => server.closeAllConnections(), 30_000);
    const clean = await supervisor.stop(signal);
    await drained;
    clearTimeout(deadline);
    if (!clean) console.error("Gateway forced child shutdown; verify retained records before restarting writers.");
    process.exit(clean ? 0 : 1);
  });
