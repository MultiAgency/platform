/**
 * Where the gateway reaches an agent's server on loopback. An agent this gateway runs (`envFile`) is reachable only
 * while its own child has said it is listening on the agent's port: otherwise another process holding that port (after
 * the child failed to bind it) would receive owner calls and answer authority checks. A live child holds its port, so
 * nothing else can take it until the child closes. An agent the gateway doesn't run is reached as configured.
 */
type Reachable = { name: string; port: number; envFile?: string };

const listening = new Set<string>();

export class AgentNotListening extends Error {
  constructor(name: string) { super(`Agent server ${name} is not running yet. Nothing was sent to it.`); }
}

/** What an agent server sends the gateway that started it, once it listens on `port`. */
export const listeningMessage = (port: number) => ({ type: "listening", port }) as const;

/** The gateway's child for `agent` reported a message: listening counts only on the agent's own port. */
export function childReported(agent: Reachable, message: unknown) {
  const m = message as { type?: unknown; port?: unknown } | null;
  if (m?.type === "listening" && m.port === agent.port) listening.add(agent.name);
}

/** The child for this agent closed, or a new one is starting: unreachable until it reports again. */
export const childStopped = (agent: Pick<Reachable, "name">) => { listening.delete(agent.name); };

export function agentOrigin(agent: Reachable) {
  if (agent.envFile !== undefined && !listening.has(agent.name)) throw new AgentNotListening(agent.name);
  return `http://127.0.0.1:${agent.port}`;
}
