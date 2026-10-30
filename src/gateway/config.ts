import { isAbsolute, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { frontendOrigin } from "./owner-frontend.js";

/**
 * The hosted dashboard's configuration, `dashboard.json` (or DASHBOARD_FILE): its agents, each an agent
 * server with its own owner, settings file and loopback port.
 */
const Config = z.object({
  /** The public host users sign in to, e.g. "dao.example.com". Bound into every sign-in signature. */
  host: z.string().min(1),
  /** Explicit host-to-demo assignments; absent preserves the legacy single-host installation. */
  hosts: z.record(z.string().regex(/^[a-z0-9.-]+(?::[0-9]+)?$/), z.object({
    demo: z.enum(["showcase", "payables", "treasury", "invoices"]),
    agents: z.array(z.string()),
    /** Trusted deployment path to an independently built frontend; never supplied by a request. */
    frontendDist: z.string().min(1).refine(isAbsolute, "Frontend directory must be absolute").optional(),
    /** An owner app's own release process (P2): its contract.json is checked before any HTML is served. */
    frontend: z.object({ origin: z.string().refine(value => { try { frontendOrigin(value); return true; } catch { return false; } }, "Frontend origin must be HTTPS, or loopback HTTP"),
      product: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict().optional(),
    hostedAreas: z.array(z.enum(["treasury", "payables"])).default([]),
  })).optional(),
  /** Fixed HTTPS intake origin; never selected by a request or used for dashboard RPC. */
  invoiceUpstream: z.url().refine(value => {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash;
  }).optional(),
  /** Where payees submit invoices, linked from the public page. */
  invoices: z.url().optional(),
  /** Walkthrough entry and bounded self-service provisioning on this single host. */
  walkthroughs: z.boolean().default(false),
  /** Setup of a hosted agent by an owner signed in on this host (`/gw/agents`). */
  selfService: z.boolean().default(false),
  /** The areas an app deployment may set up hosted agents for, with the owner's signed setup text (`/apps/v1/setup`). */
  appSetup: z.array(z.enum(["treasury", "payables"])).default([]),
  /**
   * The platform as an engine for apps: this host serves only `/health`, app access (`/apps/v1`) and the confirm page
   * with its assets. No sign-in, owner app, owner RPC, machine credentials or demo hosts.
   */
  headless: z.boolean().default(false),
  /**
   * Each agent's server: with `envFile`, the gateway runs it on `port`; without, one is already
   * running there (only one server may run per agent: each runs that agent's background loops).
   */
  agents: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]{1,32}$/),
        /** Stable presentation identity, independent of the policy's current permissions. */
        area: z.enum(["payables", "treasury"]).optional(),
        /** Explicit payee entry for this static payout agent; never inferred from global intake. */
        invoices: z.url().refine(value => {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password && !url.hash;
        }, "Contributor entry must be HTTPS without credentials or a fragment").optional(),
        /**
         * The NEAR account the agent answers to: a Sputnik DAO, whose members sign in, or any other
         * account, which signs in itself (src/gateway/roles.ts).
         */
        owner: z.string().min(2),
        envFile: z.string().optional(),
        port: z.number().int().min(1024).max(65535),
        /** false: the server here only reads and files owner proposals; another host executes for this agent. */
        executor: z.boolean().default(true),
      }),
    ),
});
type Config = z.infer<typeof Config>;
export type AgentEntry = Config["agents"][number];

export function loadConfig(file = process.env.DASHBOARD_FILE ?? "dashboard.json"): Config {
  const config = Config.parse(JSON.parse(readFileSync(file, "utf8")));
  if (!config.agents.length && !config.selfService && !config.appSetup.length) throw new Error("Configure agents or enable setup");
  if (config.headless) for (const field of ["hosts", "invoiceUpstream", "invoices"] as const)
    if (config[field] !== undefined) throw new Error(`A headless host serves apps only: remove ${field}`);
  if (config.headless && (config.walkthroughs || config.selfService)) throw new Error("A headless host serves apps only: remove walkthroughs and selfService");
  for (const agent of config.agents)
    if (agent.invoices && agent.area !== "payables") throw new Error("Only a Payables agent may configure a contributor entry");
  const names = new Set(config.agents.map((a) => a.name));
  if (names.size !== config.agents.length) throw new Error("Agent names must be unique");
  const ports = new Set(config.agents.map((a) => a.port));
  if (ports.size !== config.agents.length) throw new Error("Agent ports must be unique");
  if (config.hosts) {
    if (!Object.keys(config.hosts).length) throw new Error("At least one demo host is required");
    if (process.env.DASHBOARD_HOST) throw new Error("DASHBOARD_HOST must be unset with explicit demo hosts");
    if (!config.hosts[config.host]) throw new Error("Default host must have a demo assignment");
    for (const entry of Object.values(config.hosts)) {
      if (entry.frontend && (entry.frontendDist || entry.demo === "invoices")) throw new Error("A host serves one owner frontend: a release origin or a legacy directory, never with contributor intake");
      if (entry.frontendDist) {
        try {
          if (!statSync(join(entry.frontendDist, "index.html")).isFile()) throw new Error();
        } catch { throw new Error("Configured frontend must contain a built index.html"); }
      }
      if ((!entry.agents.length && !entry.hostedAreas.length) || new Set(entry.agents).size !== entry.agents.length) throw new Error("Demo host needs distinct assigned agents");
      if (["payables", "invoices"].includes(entry.demo) && entry.hostedAreas.includes("treasury")) throw new Error("Payment hosts cannot provision Treasury agents");
      if (entry.agents.some(name => !names.has(name))) throw new Error("Demo host names an unknown agent");
      for (const name of entry.agents) {
        const area = config.agents.find(agent => agent.name === name)?.area;
        if ((["payables", "invoices"].includes(entry.demo) && area !== "payables"))
          throw new Error("Demo host agent has the wrong area");
      }
    }
  }
  return config;
}

/**
 * The environment an agent server the gateway runs starts with: the gateway's own (API keys and other
 * shared settings), plus the agent's settings file and port, and EXECUTOR=off when another host is
 * this agent's executor. Gateway-only settings stay out.
 */
export function childEnv(agent: AgentEntry & { envFile: string }, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { SESSION_SECRET: _secret, DASHBOARD_FILE: _file, DASHBOARD_HOST: _host, DASHBOARD_AREA: _area, EXECUTOR: _executor, ...shared } = parent;
  return { ...shared, ENV_FILE: agent.envFile, PORT: String(agent.port), ...(agent.area && { DASHBOARD_AREA: agent.area }), ...(agent.executor ? {} : { EXECUTOR: "off" }) };
}

/** A host as sign-in binds it ("dao.example.com", with a port if any), also when given as a URL. */
export const hostOf = (value: string) => (value.includes("://") ? new URL(value).host : value.replace(/\/+$/, ""));
