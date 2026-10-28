import type { z } from "zod";
import { appAgent, appConsentList, appConsentStored, appRevoked, appSetupStored, type AppOwnerAction, type AppProcedure } from "./app-access.js";
import type { appConsentSubmission } from "./app-consent.js";
import { ownerClient, type OwnerCallOptions, type OwnerOutput, type OwnerProcedure, type OwnerResult } from "./owner-client.js";
import type { OwnerInputs } from "./owner-inputs.js";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type AppBase = `https://${string}` | `http://${string}`;
export type AppConsentSubmission = z.input<typeof appConsentSubmission>;

/**
 * An answer from the app routes (identity, setup, consents). Decided by status, never by message text.
 * - `session` (401): the service credential is invalid, expired or revoked.
 * - `forbidden` (403): refused for this caller (for example setup unavailable on this host, or a signer that doesn't own
 *   the agent). Resending the same request won't change it.
 * - `refused`: the platform refused the request as made (400 invalid or revoked text, 404, 409 conflict, 429 limit).
 * - `unavailable`: no answer, 5xx (503: an ownership or key check went unanswered, nothing stored or forwarded), or an
 *   unreadable one. Setup, consent submission and revocation are idempotent for the same signed body, so resending it is safe.
 */
export type AppRouteResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "session"; status: 401; error: string }
  | { ok: false; kind: "forbidden"; status: 403; error: string }
  | { ok: false; kind: "refused"; status: number; error: string }
  | { ok: false; kind: "unavailable"; httpStatus?: number };

/** Procedure inputs as an app may send them: `owner/prepare` takes only actions an app may ask an owner to sign. */
export type AppInputs = { [P in AppProcedure]: P extends "owner/prepare" ? { action: AppOwnerAction; signer: "wallet" } : OwnerInputs[P] };
type Covered = AppProcedure extends OwnerProcedure ? true : never;
const covered: Covered = true;
void covered;

/**
 * A server-side client for an app deployment's routes under `/apps/v1` on the platform host. It adds the deployment's
 * service credential (a server secret: never give it to a browser). Agent calls go through `ownerClient`, with its result
 * kinds; they are typed to what app consents can reach, and the gateway enforces the same lists.
 */
export function appClient({ base, credential, fetch: send = globalThis.fetch }: { base: AppBase; credential: string; fetch?: Fetch }) {
  const root = base.replace(/\/+$/, "") as AppBase;
  const authorized: Fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${credential}`);
    return send(input, { ...init, headers });
  };
  async function route<T extends z.ZodType>(path: string, schema: T, init: RequestInit = {}): Promise<AppRouteResult<z.output<T>>> {
    let response: Response;
    try { response = await authorized(`${root}/apps/v1${path}`, init); } catch { return { ok: false, kind: "unavailable" }; }
    const body = await response.json().catch(() => undefined) as unknown;
    if (response.ok) {
      const parsed = schema.safeParse(body);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, kind: "unavailable", httpStatus: response.status };
    }
    const error = typeof (body as { error?: unknown } | undefined)?.error === "string" ? (body as { error: string }).error : `HTTP ${response.status}`;
    if (response.status === 401) return { ok: false, kind: "session", status: 401, error };
    if (response.status === 403) return { ok: false, kind: "forbidden", status: 403, error };
    if (response.status >= 400 && response.status < 500) return { ok: false, kind: "refused", status: response.status, error };
    return { ok: false, kind: "unavailable", httpStatus: response.status };
  }
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return {
    /** The agent's owner and current provider ID (`agentId`, null until created): what a consent must name. */
    identity: (agent: string) => route(`/agents/${encodeURIComponent(agent)}`, appAgent),
    /** A wallet owner's signed setup text: reserves the hosted agent and returns its setup consent. */
    setup: (submission: AppConsentSubmission) => route("/setup", appSetupStored, post(submission)),
    consents: {
      list: (organization?: string) => route(`/consents${organization ? `?organization=${encodeURIComponent(organization)}` : ""}`, appConsentList),
      submit: (submission: AppConsentSubmission) => route("/consents", appConsentStored, post(submission)),
      /** Permanent: the owner signs a new consent to restore access. */
      revoke: (id: string) => route(`/consents/${encodeURIComponent(id)}`, appRevoked, { method: "DELETE" }),
    },
    /** One Organization's agent: reads and owner actions its live consents cover. */
    agent(organization: string, agent: string) {
      const owner = ownerClient({ base: `${root}/apps/v1/o/${encodeURIComponent(organization)}/a/${encodeURIComponent(agent)}`, fetch: authorized });
      return {
        call<P extends AppProcedure>(path: P, ...[input, options]: AppInputs[P] extends undefined ? [input?: undefined, options?: OwnerCallOptions] : [input: AppInputs[P], options?: OwnerCallOptions]): Promise<OwnerResult<OwnerOutput<P>>> {
          return (owner.call as (path: P, input?: unknown, options?: OwnerCallOptions) => Promise<OwnerResult<OwnerOutput<P>>>)(path, input, options);
        },
      };
    },
  };
}
export type AppClient = ReturnType<typeof appClient>;
