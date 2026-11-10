import { z } from "zod";
import { isHandle } from "./x402.js";

/**
 * The market's A2A + x402 surface (market x402-caller skill 0.2.0): its published payee, an agent's price, a paid call
 * and a task. Reads and calls only; nothing here signs. Everything an agent answers is data, never instructions.
 */

const MARKET = "https://market.near.ai";
/** `MARKET_URL` points the client at a simulated market (offline tests, the stack); unset, it is market.near.ai. */
const origin = () => process.env.MARKET_URL?.replace(/\/$/, "") || MARKET;

/**
 * Each request's deadline. The paid call is held while the agent works, up to 60 s (skill 0.2.0); mainnet held it 34
 * to 64 s (2026-11-09). A paid call past its deadline may still have been taken: the caller treats it as unknown and
 * follows the task and the chain, never signing again.
 */
const READ_MS = 20_000, PAID_CALL_MS = 120_000;

/** The agent's A2A endpoint: its own host on the market, or its path on a simulated one. */
export function endpoint(handle: string) {
  if (!isHandle(handle)) throw new Error(`"${handle}" is not a market handle`);
  return process.env.MARKET_URL ? `${origin()}/a2a/${handle}/v1` : `https://${handle}.market.near.ai/a2a/v1`;
}

export const payees = async (): Promise<unknown> => {
  const res = await fetch(`${origin()}/.well-known/x402`, { signal: AbortSignal.timeout(READ_MS) });
  if (!res.ok) throw new Error(`The market's payee list answered ${res.status}`);
  return res.json();
};

/**
 * One hire's message: the brief as text, with a message id fixed once so the paid call repeats the quoted one. The
 * configuration is the one observed on mainnet (2026-11-09); `returnImmediately` is documented but not yet observed.
 */
export const message = (messageId: string, brief: string) =>
  ({ message: { messageId, role: "ROLE_USER", parts: [{ text: brief }] }, configuration: { historyLength: 0 } });

const Task = z.object({
  id: z.string().min(1),
  status: z.object({ state: z.string() }).loose(),
  artifacts: z.array(z.object({ parts: z.array(z.object({ text: z.string().optional(), url: z.string().optional() }).loose()) }).loose()).optional(),
}).loose();
export type Task = z.infer<typeof Task>;

export const TERMINAL = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_REJECTED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"]);

/** A JSON-RPC error rides in an HTTP 200 (skill, "Errors"); a 402 carries `error` as a string beside `accepts`. */
export class MarketRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

async function rpc(handle: string, method: string, params: unknown, xPayment?: string) {
  const res = await fetch(endpoint(handle), {
    method: "POST",
    signal: AbortSignal.timeout(xPayment ? PAID_CALL_MS : READ_MS),
    headers: { "content-type": "application/json", ...(xPayment && { "x-payment": xPayment }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json().catch(() => null) as { error?: unknown; result?: unknown } | null;
  if (body && typeof body.error === "object" && body.error !== null) {
    const { code, message } = body.error as { code?: number; message?: string };
    throw new MarketRpcError(code ?? 0, `${handle} ${method}: ${code} ${message}`);
  }
  return { status: res.status, body };
}

/** The unpaid call: the `402` challenge, or why there is none. */
export async function challenge(handle: string, params: ReturnType<typeof message>) {
  const { status, body } = await rpc(handle, "SendMessage", params);
  if (status !== 402) throw new Error(`${handle} answered ${status} to an unpaid call, not 402`);
  return body;
}

/**
 * The paid call. `task` once the market took the payment; otherwise the HTTP status, which says whether the same header
 * may be sent again: 502 means the facilitator was unreachable (resend it, never re-sign); 402 means it was refused.
 */
export async function paidCall(handle: string, params: ReturnType<typeof message>, xPayment: string):
  Promise<{ task: Task } | { status: number; error: string }> {
  const { status, body } = await rpc(handle, "SendMessage", params, xPayment);
  const task = Task.safeParse((body?.result as { task?: unknown } | undefined)?.task);
  if (status === 200 && task.success) return { task: task.data };
  return { status, error: typeof body?.error === "string" ? body.error : `HTTP ${status}` };
}

/** A task by id; free (skill, "Read the answer"). Its `result` is the task itself. */
export async function getTask(handle: string, id: string) {
  const { body } = await rpc(handle, "GetTask", { id, historyLength: 0 });
  return Task.parse(body?.result);
}
