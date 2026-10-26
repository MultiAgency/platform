import { z } from "zod";
import type { Access } from "./permissions.js";

/**
 * The hosted gateway's own routes (`gateway-session-v1`), as owner frontends read them. Discovery describes what this
 * host shows; it grants nothing. Every agent call is still authorized per session, agent and procedure.
 */
const area = z.enum(["treasury", "payables"]);
/** An HTTP(S) payee entry. The protocol is checked by the URL schema itself, so a malformed value fails the parse. */
const entry = z.url({ protocol: /^https?$/ });
export const gatewayAccess = z.looseObject({ canSign: z.boolean(), canPropose: z.boolean(), canVote: z.boolean(), canExecute: z.boolean(), canManage: z.boolean() });

export const gatewayAgent = z.looseObject({
  name: z.string().regex(/^[a-z0-9-]{1,32}$/),
  owner: z.string().min(1),
  /** Whether the owner is a Sputnik DAO (owner actions then pass through its votes). */
  dao: z.boolean(),
  area: area.optional(),
  /** A self-service instance created through `/gw/agents`. */
  managed: z.boolean().optional(),
  /** This agent's payee entry, or null when it has none. Absent: the host-wide `invoices` applies. */
  invoices: entry.nullable().optional(),
});

/** `GET /gw/me`: the agents this host shows the visitor, and the signed-in account's access to each. */
export const gatewayDiscovery = z.looseObject({
  agents: z.array(gatewayAgent),
  invoices: entry.nullable(),
  /** Null when signed out, or signed in without access here. */
  viewer: z.looseObject({ account: z.string().min(1), access: z.record(z.string(), gatewayAccess) }).nullable(),
  /** The hosts serving each app area on this deployment. */
  apps: z.record(z.string(), z.string()).optional(),
  demo: z.enum(["showcase", "payables", "treasury", "invoices"]).optional(),
  /** The owner-app capabilities this host provides (`ownerCapabilities`). */
  capabilities: z.array(z.string()).optional(),
  /** The areas the visitor may create agents in here. */
  setupAreas: z.array(area).optional(),
  selfService: z.boolean().optional(),
  walkthroughs: z.boolean().optional(),
});
export type GatewayDiscovery = z.output<typeof gatewayDiscovery>;
export type GatewayAgent = z.output<typeof gatewayAgent>;

/** Why the gateway refused: no valid session, no access to this agent, or no permission for this procedure. */
export const GATEWAY_DENIAL_SCOPES = ["session", "agent", "procedure"] as const;
export type GatewayDenialScope = (typeof GATEWAY_DENIAL_SCOPES)[number];
/** The gateway's own 401/403 answer. `access` is absent from older gateways, machine routes and proxies. */
export const gatewayDenial = z.looseObject({ error: z.string(), access: z.enum(GATEWAY_DENIAL_SCOPES).optional() });

/** The scope a gateway denial body declares, or undefined when it declares none: the caller decides its own default. */
export function gatewayDenialScope(body: unknown): GatewayDenialScope | undefined {
  const parsed = gatewayDenial.safeParse(body);
  return parsed.success ? parsed.data.access : undefined;
}

// The discovery access record is the permission module's Access, both ways.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const accessMatches: Same<Pick<z.output<typeof gatewayAccess>, keyof Access>, Access> = true;
void accessMatches;
