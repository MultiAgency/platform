import { z } from "zod";
import { requestRecord, reportCommand } from "../compensation-contract.js";
import { payeeContract } from "../payee-contract.js";
import { PAYEE_POLICY_PATH, payeePolicyProof, payeePolicyRequest } from "./payee-policy.js";
import { agentConnectionIssue, agentConnectionList, agentConnectionRevoked, agentConnectionStarted } from "./agent-connection.js";
import { compensationSession, errorBody, fileResult, invoicesView, publicWorkOrder, session, signInResult, signOutResult,
  payeeCompensationView, workOrderList, payeeWorkOrderRequest, workOrderRequestResult } from "./payee.js";

export const capabilities = z.object({ version: z.literal(payeeContract.version), product: z.literal(payeeContract.product), capabilities: z.array(z.string()) });
export const signInChallenge = z.object({ message: z.string(), recipient: z.string(), nonce: z.string() });
export const signIn = z.object({ accountId: z.string(), publicKey: z.string(), signature: z.string(), nonce: z.string(), callbackUrls: z.array(z.string()).max(3).optional() });

/** The caller's retained identity for a mutation. The client never mints or replaces one. */
export type Identity =
  | { submission: string }
  | { invoiceId: string }
  | { workOrderId: string }
  | { commandId: string; id: string; expectedVersion: number };

/**
 * `session` (401) and `forbidden` (403) stay distinct: a refusal is not proof that the session expired.
 * `unknown`: a mutation was sent and its outcome is not known. Keep the identity and draft, read the
 * existing record, and never send a replacement. `unavailable`: a read failed; reading again is safe.
 */
export type Failure =
  | { ok: false; kind: "session"; status: 401; error: string }
  | { ok: false; kind: "forbidden"; status: 403; error: string }
  | { ok: false; kind: "refused"; status: number; error: string; code?: string }
  | { ok: false; kind: "unavailable" }
  | { ok: false; kind: "unknown"; identity: Identity };
export type Result<T> = { ok: true; value: T } | Failure;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Typed payee routes relative to an instance base (`""` or `/i/own-<24 hex>`). Same-origin in a browser; no retries.
 * With `token` (an agent connection, `tac_…`) the client runs outside a browser: `base` is the entry's absolute URL, the
 * token is sent as a bearer and no cookie is sent. Only the connection's permitted routes answer; others are `forbidden`.
 */
export function payeeClient({ base = "", fetch: send = globalThis.fetch, token }: { base?: string; fetch?: Fetch; token?: string } = {}) {
  async function call<T>(schema: z.ZodType<T>, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, identity?: Identity): Promise<Result<T>> {
    const lost = (): Failure => identity ? { ok: false, kind: "unknown", identity } : { ok: false, kind: "unavailable" };
    let response: Response;
    try {
      response = await send(`${base}${path}`, { method, credentials: token ? "omit" : "same-origin",
        headers: { accept: "application/json", ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }) });
    } catch { return lost(); }
    let json: unknown, readable = true;
    try { json = await response.json(); } catch { readable = false; }
    const answer = errorBody.safeParse(json);
    // 401 and 403 are decided by status alone: a proxy or gateway page still ends the session or refuses.
    if (response.status === 401) return { ok: false, kind: "session", status: 401, error: answer.success ? answer.data.error : "Sign in again." };
    if (response.status === 403) return { ok: false, kind: "forbidden", status: 403, error: answer.success ? answer.data.error : "This account may not do that." };
    if (!readable) return lost();
    if (response.ok) {
      const parsed = schema.safeParse(json);
      return parsed.success ? { ok: true, value: parsed.data } : lost();
    }
    // A gateway or server failure may follow an accepted mutation; only a 4xx answer is a refusal.
    if (response.status >= 500) return lost();
    return { ok: false, kind: "refused", status: response.status, error: answer.success ? answer.data.error : "Request refused.", ...(answer.success && answer.data.code && { code: answer.data.code }) };
  }
  return {
    capabilities: () => call(capabilities, "GET", "/api/capabilities"),
    // supplier-session-v1
    session: () => call(session, "GET", "/api/session"),
    signInChallenge: () => call(signInChallenge, "POST", "/api/signin/challenge", {}),
    signIn: (input: z.infer<typeof signIn>) => call(signInResult, "POST", "/api/signin", signIn.parse(input)),
    signOut: () => call(signOutResult, "POST", "/api/signout", {}),
    // supplier-invoices-v1
    invoices: () => call(invoicesView, "GET", "/api/invoices"),
    submitInvoice: (input: { submission: string; amount: string; note: string }) =>
      call(fileResult, "POST", "/api/invoices", input, { submission: input.submission }),
    continueInvoice: (invoiceId: string) => call(fileResult, "POST", `/api/invoices/${encodeURIComponent(invoiceId)}/continue`, {}, { invoiceId }),
    // supplier-work-orders-v1
    workOrders: () => call(workOrderList, "GET", "/api/work-orders"),
    workOrder: (id: string) => call(publicWorkOrder, "GET", `/api/work-orders/${encodeURIComponent(id)}`),
    fileWorkOrder: (id: string) => call(fileResult, "POST", `/api/work-orders/${encodeURIComponent(id)}/file`, {}, { workOrderId: id }),
    // supplier-work-order-requests-v1
    requestWorkOrder: (input: z.infer<typeof payeeWorkOrderRequest>) =>
      call(workOrderRequestResult, "POST", "/api/work-orders", payeeWorkOrderRequest.parse(input), { submission: input.submission }),
    // supplier-compensation-v2
    compensationSession: () => call(compensationSession, "GET", "/api/compensation/session"),
    compensationSignIn: (input: z.infer<typeof signIn>) => call(signInResult, "POST", "/api/compensation/signin", signIn.parse(input)),
    compensation: () => call(payeeCompensationView, "GET", "/api/compensation"),
    submitReport: (command: z.infer<typeof reportCommand>) => {
      const parsed = reportCommand.parse(command);
      return call(requestRecord, "POST", "/api/compensation", parsed, { commandId: parsed.commandId, id: parsed.id, expectedVersion: parsed.expectedVersion });
    },
    // supplier-agent-connections-v1: managed from the signed-in browser session only (a bearer is refused).
    agentConnections: () => call(agentConnectionList, "GET", "/api/agent-connections"),
    /** A lost answer is `unavailable`: a started connection is not a money action, and an orphan is listed and revocable. */
    startAgentConnection: (input: z.input<typeof agentConnectionIssue>) => call(agentConnectionStarted, "POST", "/api/agent-connections", agentConnectionIssue.parse(input)),
    revokeAgentConnection: (id: string) => call(agentConnectionRevoked, "DELETE", `/api/agent-connections/${encodeURIComponent(id)}`),
    // Served by the platform host, not a payee entry: build this client with `base` the host's origin (no token).
    /**
     * The payee's own terms in the policy that pays them, under the owner's signed payee disclosure and the payee's signed
     * read (`payeeDisclosureMessage`, `payeePolicyReadMessage`). A read: a lost answer is `unavailable`.
     */
    policyProof: (input: z.input<typeof payeePolicyRequest>) => call(payeePolicyProof, "POST", PAYEE_POLICY_PATH, payeePolicyRequest.parse(input)),
  };
}
export type PayeeClient = ReturnType<typeof payeeClient>;
