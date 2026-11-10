import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { parseEnv } from "node:util";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { mkdirSynced, writeAtomic } from "../synced.js";
import { newPaymentKey } from "../market/payment-key.js";
import { accessOf, type Owner } from "./roles.js";
import type { AgentEntry } from "./config.js";
import { area, frontendArea } from "../contract/areas.js";

export const setupRequest = z.strictObject({
  owner: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  kind: z.enum(["wallet", "dao"]),
  area,
});
export type SetupRequest = z.infer<typeof setupRequest>;
/** Self-service (`/gw/agents`) sets up only the owner frontend's areas; a market agent is an app's. */
export const selfServiceRequest = setupRequest.extend({ area: frontendArea });
/**
 * An app's setup also names its deployment and Organization: that Organization gets its own agent per owner and area,
 * reachable only by that deployment's calls for that Organization. Self-service setups (`/gw/agents`) have no scope.
 */
const organizationScope = { deployment: z.string().regex(/^[a-z0-9-]{1,32}$/), organization: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) };
export type OrganizationScope = { deployment: string; organization: string };
type Reservation = SetupRequest & Partial<OrganizationScope>;
const entry = setupRequest.extend({ name: z.string(), port: z.number().int().min(9000).max(9999) });
/**
 * Self-service reservations stay in `registry.json`, in exactly the format earlier releases read, so a rollback still
 * starts while those records remain readable. Organization reservations live in shared `apps.json`: 0.5.5 reads it
 * but rejects a market area's entry, preventing the whole gateway from starting. After shared market records exist,
 * downgrade below 0.5.6 is unsupported (docs/market.md); preserving only x402 journals is not sufficient.
 */
const registry = z.strictObject({ version: z.literal(1), entries: z.array(entry).max(1000) });
const appRegistry = z.strictObject({ version: z.literal(1), entries: z.array(entry.extend(organizationScope)).max(1000) });
const releaseEntry = entry.extend(organizationScope).extend({ agentId: z.string().min(1), at: z.iso.datetime(),
  archiveCorrelationId: z.string().nullable(), state: z.enum(["releasing", "released", "restored"]) });
const releaseRegistry = z.strictObject({ version: z.literal(1), entries: z.array(releaseEntry) });
export type ReleasedAgent = z.output<typeof releaseEntry>;
const nameOf = (input: Reservation) => `own-${createHash("sha256").update(input.deployment === undefined ? `${input.owner}:${input.area}`
  : `app:${input.deployment}:${input.organization}:${input.owner}:${input.area}`).digest("hex").slice(0,24)}`;
const sameScope = (a: Partial<OrganizationScope>, b: Partial<OrganizationScope>) => a.deployment === b.deployment && a.organization === b.organization;
/** At most this many Organization agents per app deployment, so one deployment can't take a host's capacity. */
export const PER_DEPLOYMENT = 16;
export type HostedAgent = AgentEntry & SetupRequest & Partial<OrganizationScope> & { envFile: string };

/** Share infrastructure only, never an existing owner's notifications, intake, signing key or grant. */
export function hostedEnvironment(agent: HostedAgent, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shared: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "NODE_OPTIONS", "NODE_ENV", "PROTO_TEST_MODE", "NEAR_INTENTS_AGENT_API_KEY", "NEAR_INTENTS_AGENT_API_URL", "NEAR_RPC_URL", "FASTNEAR_API_KEY",
    // The agent market a market agent hires on (docs/market.md): unset, market.near.ai; an operator's simulated one in tests.
    "MARKET_URL", "MARKET_MAX_WINDOW_SECONDS"])
    if (parent[key] !== undefined) shared[key] = parent[key];
  return { ...shared, ENV_FILE: agent.envFile, PORT: String(agent.port), DASHBOARD_AREA: agent.area,
    HOSTED_OWNER: agent.owner, HOSTED_OWNER_KIND: agent.kind, EXECUTOR: "on" };
}

/** Authentication proves the member; DAO membership and proposal rights establish setup access. */
export function authorizeSetup(account: string, kind: SetupRequest["kind"], owner: Owner) {
  const access = accessOf(account, owner);
  if ((kind === "dao") !== Boolean(owner.policy) || !access || !(kind === "dao" ? access.canPropose : access.canSign))
    throw new Error("Sign in as this wallet's owner or a DAO member who can propose owner actions.");
}

/** Additive state. Reservations precede process startup and never replace an existing settings file. */
const PORTS = Array.from({ length: 1000 }, (_, i) => 9000 + i);

/** Which of these loopback ports another process holds now (a probe: the answer can change right after). */
export async function boundPorts(ports: readonly number[]): Promise<Set<number>> {
  const bound = await Promise.all(ports.map(port => new Promise<boolean>(done => {
    const probe = createServer().once("error", () => done(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(false)));
  })));
  return new Set(ports.filter((_, i) => bound[i]));
}

export class HostedAgents {
  constructor(private directory: string, private configured: AgentEntry[], private capacity = 32, private perDeployment = PER_DEPLOYMENT) { this.list(); }
  /** Single-host lifecycle serialization: setup cannot restore while release is awaiting checks or child shutdown. */
  async withLifecycle<T>(name: string, run: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    let held = true;
    const unlock = await lockfile.lock(join(this.directory, `${name}.lifecycle`), { realpath: false, retries: 0, stale: 60_000,
      onCompromised: () => { held = false; } });
    try { return await run(() => { if (!held) throw new Error("Hosted lifecycle lock lost"); }); }
    finally { if (held) { held = false; await unlock(); } }
  }
  /** History is retained through restoration; the most recent release supplies the consent cutoff. */
  releases(): ReleasedAgent[] {
    const file = join(this.directory, "released.json");
    const records = existsSync(file) ? releaseRegistry.parse(JSON.parse(readFileSync(file, "utf8"))).entries : [];
    if (records.some(r => r.name !== nameOf(r) || !existsSync(join(this.directory, `${r.name}.env`))))
      throw new Error("Released agent registry is unavailable. Preserve its records and settings.");
    return records;
  }
  released(name: string) { return this.releases().findLast(r => r.name === name && r.state !== "restored"); }
  private writeReleases(entries: ReleasedAgent[]) {
    writeAtomic(join(this.directory, "released.json"), JSON.stringify(releaseRegistry.parse({ version: 1, entries })), 0o600);
  }
  /** Caller has already marked the executor under its money lock. Write the tombstone before removing its slot. */
  release(name: string, evidence: { agentId: string; at: string; archiveCorrelationId: string | null }): ReleasedAgent {
    const unlock = lockfile.lockSync(join(this.directory, "registry.json"), { realpath: false, retries: 0, stale: 60_000 });
    try {
      const records = this.releases();
      let record = records.findLast(r => r.name === name && r.state !== "restored");
      if (!record) {
        const current = this.list().find(a => a.name === name);
        if (!current?.deployment || !current.organization || current.kind !== "wallet") throw new Error("Only an app's wallet-owned reservation can be released.");
        const { envFile: _env, executor: _executor, ...reservation } = current;
        record = releaseEntry.parse({ ...reservation, agentId: evidence.agentId, at: evidence.at, archiveCorrelationId: evidence.archiveCorrelationId, state: "releasing" });
        records.push(record); this.writeReleases(records);
      } else if (record.agentId !== evidence.agentId) throw new Error("Release identity changed");
      const file = join(this.directory, "apps.json");
      const apps = appRegistry.parse(JSON.parse(readFileSync(file, "utf8")));
      writeAtomic(file, JSON.stringify({ ...apps, entries: apps.entries.filter(a => a.name !== name) }), 0o600);
      return record;
    } finally { unlock(); }
  }
  completeRelease(name: string) {
    const unlock = lockfile.lockSync(join(this.directory, "registry.json"), { realpath: false, retries: 0, stale: 60_000 });
    try {
      const records = this.releases(), current = records.findLast(r => r.name === name && r.state !== "restored");
      if (!current) throw new Error("No release to complete");
      current.state = "released"; this.writeReleases(records);
      return current;
    } finally { unlock(); }
  }
  list(): HostedAgent[] {
    try {
      const read = (name: string) => { const file = join(this.directory, name); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as unknown : { version: 1, entries: [] }; };
      const entries: (z.output<typeof entry> & Partial<OrganizationScope>)[] = [...registry.parse(read("registry.json")).entries, ...appRegistry.parse(read("apps.json")).entries];
      const released = new Set(this.releases().filter(r => r.state !== "restored").map(r => r.name));
      const names = new Set(this.configured.map(a => a.name));
      const ports = new Set(this.configured.map(a => a.port));
      return entries.filter(value => !released.has(value.name)).map(value => {
        const envFile = join(this.directory, `${value.name}.env`);
        if (value.name !== nameOf(value) || names.has(value.name) || ports.has(value.port) || !existsSync(envFile))
          throw new Error("Conflicting or incomplete reservation");
        names.add(value.name); ports.add(value.port);
        return { ...value, envFile, executor: true };
      });
    } catch { throw new Error("Hosted agent registry is unavailable. Preserve registry and settings before recovery."); }
  }
  private clearReleaseMarker(file: string, agentId: string) {
    file = realpathSync(file);
    const unlock = lockfile.lockSync(file, { realpath: false, retries: 0, stale: 60_000 });
    try {
      const text = readFileSync(file, "utf8"), env = parseEnv(text);
      if (!env.RELEASED_AT) return;
      if (env.AGENT_ID !== agentId) throw new Error("The retained provider agent identity changed; preserve the settings.");
      writeAtomic(file, text.split("\n").filter(l => !/^(RELEASED_AT|RELEASED_ARCHIVE|RESTORE_REQUIRED)=/.test(l)).join("\n").trimEnd() + `\nRESTORE_REQUIRED=${agentId}\n`, 0o600);
    } finally { unlock(); }
  }
  /** The next `count` ports no configured or hosted agent has reserved, lowest first. */
  unreservedPorts(count: number): number[] {
    const ports = new Set([...this.configured, ...this.list()].map(a => a.port));
    return PORTS.filter(p => !ports.has(p)).slice(0, count);
  }
  /**
   * The owner's existing agent for this area and scope, or a new reservation on a port neither reserved nor in `bound`
   * (ports another process held when probed: an agent server that can't bind its port never becomes reachable).
   */
  reserve(raw: SetupRequest, scope?: OrganizationScope, bound: ReadonlySet<number> = new Set()): HostedAgent {
    const input: Reservation = { ...setupRequest.parse(raw), ...(scope && z.strictObject(organizationScope).parse(scope)) };
    mkdirSynced(this.directory);
    const lifecycle = lockfile.lockSync(join(this.directory, `${nameOf(input)}.lifecycle`), { realpath: false, retries: 0, stale: 60_000 });
    // One lock for both files: they share names, ports and capacity.
    let release: (() => void) | undefined;
    try {
      release = lockfile.lockSync(join(this.directory, "registry.json"), { realpath: false, retries: 0, stale: 60_000 });
      const entries = this.list();
      const releases = this.releases();
      const restoring = releases.findLast(r => r.name === nameOf(input) && r.state !== "restored");
      if (restoring?.state === "releasing") throw new Error("The release must finish before this agent is restored.");
      if (restoring && restoring.kind !== input.kind) throw new Error("The reserved owner type differs.");
      const previous = entries.find(a => a.owner === input.owner && a.area === input.area && sameScope(a, input));
      if (previous) {
        if (previous.kind !== input.kind) throw new Error("The reserved owner type differs. Review the existing agent.");
        const last = releases.findLast(r => r.name === previous.name);
        if (last) {
          if (last.state !== "restored") { last.state = "restored"; this.writeReleases(releases); }
          this.clearReleaseMarker(previous.envFile, last.agentId);
        }
        return previous;
      }
      if (!scope && this.configured.some(a => a.owner === input.owner && a.area === input.area))
        throw new Error("Open the existing agent for this owner and area.");
      if (entries.length >= this.capacity) throw new Error("Hosted agent capacity reached. Existing agents remain available.");
      if (scope && entries.filter(a => a.deployment === scope.deployment).length >= this.perDeployment)
        throw new Error("This app deployment has reached its hosted agent limit on this host. Existing agents remain available.");
      const ports = new Set([...this.configured, ...entries].map(a => a.port));
      const port = PORTS.find(p => !ports.has(p) && !bound.has(p));
      if (!port) throw new Error("Hosted agent capacity reached.");
      const name = nameOf(input);
      const envFile = join(this.directory, `${name}.env`);
      if (!restoring && existsSync(envFile)) throw new Error("An unregistered settings file exists. Preserve it and recover the registry before retrying.");
      // A market agent's payment key is written here once, before the agent exists: its policy names the key's account.
      if (!restoring) writeAtomic(envFile, `AUTOPILOT=off\n${input.kind === "dao" ? `TREASURY_ACCOUNT=${input.owner}\n` : ""}`
        + (input.area === "market" ? `MARKET_PAYMENT_KEY=${newPaymentKey()}\n` : ""), 0o600);
      const value = { ...input, name, port };
      const kept = entries.filter(a => (a.deployment === undefined) === !scope)
        .map(({ name, port, owner, kind, area, deployment, organization }) => ({ name, port, owner, kind, area, ...(scope && { deployment, organization }) }));
      writeAtomic(join(this.directory, scope ? "apps.json" : "registry.json"), JSON.stringify({ version: 1, entries: [...kept, value] }), 0o600);
      if (restoring) {
        // Keep the send refusal until both registries record restoration. A crash leaves sends blocked;
        // repeating this signed setup completes it rather than replacing the provider agent or key.
        restoring.state = "restored"; this.writeReleases(releases);
        this.clearReleaseMarker(envFile, restoring.agentId);
      }
      return { ...value, envFile, executor: true };
    } finally { try { release?.(); } finally { lifecycle(); } }
  }
}
