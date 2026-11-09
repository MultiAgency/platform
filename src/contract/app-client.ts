import type { z } from "zod";
import { retryAfterSeconds } from "./retry-after.js";
import { appAgent, appConsentList, appConsentNonce, appConsentStored, appDaoConsentFiled, appDaoConsentState, appDaoSetupFiled, appDaoSetupState, appDaoVoteFiled, appDaoVoteState, appRevoked, appSetupStored, type AppDaoAction, type AppOwnerAction, type AppProcedure } from "./app-access.js";
import type { appConsentSubmission } from "./app-consent.js";
import { ownerClient, type OwnerCallOptions, type OwnerFailure, type OwnerOutput, type OwnerProcedure, type OwnerResult } from "./owner-client.js";
import type { ownerStreams } from "./owner-outputs.js";
import type { OwnerInputs } from "./owner-inputs.js";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type AppBase = `https://${string}` | `http://${string}`;
export type AppConsentSubmission = z.input<typeof appConsentSubmission>;

/**
 * An answer from the app routes (identity, setup, consents, DAO requests). Decided by `kind` and `code`, never by message
 * text; `code` is an `AppGatewayCode` (absent from older gateways).
 * - `session` (401): the service credential is invalid, expired or revoked.
 * - `forbidden` (403): refused for this caller (for example setup unavailable on this host, or a signer that doesn't own
 *   the agent). Resending the same request won't change it.
 * - `refused`: the platform refused the request as made (400, 404, 409, 410). Only `agent_refused` can change by
 *   reading again; the others need a new request.
 * - `rate_limited` (429): the deployment's request limit; nothing was done. Send the same request again after
 *   `retryAfterSeconds` (from `Retry-After`) when given. A 429 without the gateway's JSON (a proxy page) stays `refused`.
 * - `unavailable`: no answer, 5xx (503: an ownership or key check went unanswered, nothing stored or forwarded), an
 *   unreadable one, or an aborted call. Sending the same request again is safe on every app route, writes included:
 *   setup, consent submission and revocation are idempotent for the same signed body; a DAO filing whose answer was lost
 *   files a new request, and the lost one is harmless, since only its answer carried the transactions a member signs.
 */
export type AppRouteResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "session"; status: 401; error: string }
  | { ok: false; kind: "forbidden"; status: 403; error: string; code?: string }
  | { ok: false; kind: "refused"; status: number; error: string; code?: string }
  | { ok: false; kind: "rate_limited"; status: 429; error: string; retryAfterSeconds?: number }
  | { ok: false; kind: "unavailable"; httpStatus?: number };

/** What `owner/prepare` answers, whichever signer asked. */
export type AppPrepared = OwnerOutput<"owner/prepare">;
/** `signer: "dao"`: the DAO's transactions a member files, and the policy for an edit. */
export type AppDaoPrepared = AppPrepared & { dao: NonNullable<AppPrepared["dao"]> };
/**
 * `signer: "wallet"`: an intent the owner's wallet signs (NEP-413), the platform's confirm link (NEP-366), or for a vote
 * on a held payout both.
 */
export type AppWalletPrepared = AppPrepared & ({ intent: NonNullable<AppPrepared["intent"]> } | { confirm: NonNullable<AppPrepared["confirm"]> });
/** Narrows `owner/prepare`'s answer to the DAO's, which carries the transactions a member files. */
export const isDaoPrepared = (prepared: AppPrepared): prepared is AppDaoPrepared => prepared.dao !== undefined;
/** Narrows `owner/prepare`'s answer to the wallet's: an intent to sign, or a confirm link to send the owner to. */
export const isWalletPrepared = (prepared: AppPrepared): prepared is AppWalletPrepared =>
  prepared.intent !== undefined || prepared.confirm !== undefined;

/** Per-call options for the app routes: an aborted call is `unavailable`, and sending the same request again is safe. */
export type AppRouteOptions = { signal?: AbortSignal };

/** Procedure inputs as an app may send them: `owner/prepare` takes only actions an app may ask an owner to sign. */
export type AppInputs = { [P in AppProcedure]: P extends "owner/prepare"
  ? { action: AppOwnerAction; signer: "wallet" } | { action: AppDaoAction; signer: "dao" } : OwnerInputs[P] };
/** The app procedures that answer an event stream. */
type AppStream = Extract<AppProcedure, (typeof ownerStreams)[number]>;
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
  async function route<T extends z.ZodType>(path: string, schema: T, init: RequestInit = {}, options?: AppRouteOptions): Promise<AppRouteResult<z.output<T>>> {
    let response: Response;
    try { response = await authorized(`${root}/apps/v1${path}`, { ...init, ...(options?.signal && { signal: options.signal }) }); }
    catch { return { ok: false, kind: "unavailable" }; }
    const body = await response.json().catch(() => undefined) as unknown;
    if (response.ok) {
      const parsed = schema.safeParse(body);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, kind: "unavailable", httpStatus: response.status };
    }
    const error = typeof (body as { error?: unknown } | undefined)?.error === "string" ? (body as { error: string }).error : `HTTP ${response.status}`;
    const code = typeof (body as { code?: unknown } | undefined)?.code === "string" ? { code: (body as { code: string }).code } : {};
    if (response.status === 401) return { ok: false, kind: "session", status: 401, error };
    if (response.status === 403) return { ok: false, kind: "forbidden", status: 403, error, ...code };
    // Only the gateway's own JSON answer: a proxy's 429 page says nothing about this request, as for agent calls.
    if (response.status === 429 && typeof (body as { error?: unknown } | undefined)?.error === "string") {
      const after = retryAfterSeconds(response.headers);
      return { ok: false, kind: "rate_limited", status: 429, error, ...(after !== undefined && { retryAfterSeconds: after }) };
    }
    if (response.status >= 400 && response.status < 500) return { ok: false, kind: "refused", status: response.status, error, ...code };
    return { ok: false, kind: "unavailable", httpStatus: response.status };
  }
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return {
    /** The agent's owner and current provider ID (`agentId`, null until created): what a consent must name. */
    identity: (agent: string, options?: AppRouteOptions) => route(`/agents/${encodeURIComponent(agent)}`, appAgent, {}, options),
    /** A wallet owner's signed setup text: reserves the hosted agent and returns its setup consent. */
    setup: (submission: AppConsentSubmission, options?: AppRouteOptions) => route("/setup", appSetupStored, post(submission), options),
    consents: {
      list: (organization?: string, options?: AppRouteOptions) =>
        route(`/consents${organization ? `?organization=${encodeURIComponent(organization)}` : ""}`, appConsentList, {}, options),
      submit: (submission: AppConsentSubmission, options?: AppRouteOptions) => route("/consents", appConsentStored, post(submission), options),
      /** Permanent: the owner signs a new consent to restore access. */
      revoke: (id: string, options?: AppRouteOptions) => route(`/consents/${encodeURIComponent(id)}`, appRevoked, { method: "DELETE" }, options),
      /**
       * A NEP-413 nonce for the owner to sign the next consent or setup text with, in place of one the app picks. It shows
       * the text was signed after any wallet stop the owner signed before: after a stop, only such a text is stored
       * (`owner_stopped` otherwise). Ask for one per text.
       */
      nonce: (options?: AppRouteOptions) => route("/consent-nonces", appConsentNonce, post({}), options),
    },
    /**
     * A DAO owner's consent, signed by the DAO's own vote. `file` takes the canonical consent text (scopes within
     * `DAO_CONSENT_SCOPES`) and answers the proposal a member files; `state` reads it until the DAO's signature is
     * found, then the stored consent. Filing the same text again files a new request: follow the one you have.
     */
    daoConsents: {
      file: (message: string, options?: AppRouteOptions) => route("/dao-consents", appDaoConsentFiled, post({ message }), options),
      state: (id: string, options?: AppRouteOptions) => route(`/dao-consents/${encodeURIComponent(id)}`, appDaoConsentState, {}, options),
    },
    /**
     * A DAO's hosted Treasury agent, set up by its vote: `file` takes the canonical setup text (owner the DAO, area
     * within `DAO_SETUP_AREAS`, at most 7 days) and answers the proposal a member files; `state` reads it until the
     * DAO's signature is found, then the reserved agent and its setup consent. Then ask for `agent_create` with
     * `signer: "dao"` (a vote that must pass within minutes), and once created file the DAO's consent naming its ID.
     */
    daoSetups: {
      file: (message: string, options?: AppRouteOptions) => route("/dao-setups", appDaoSetupFiled, post({ message }), options),
      state: (id: string, options?: AppRouteOptions) => route(`/dao-setups/${encodeURIComponent(id)}`, appDaoSetupState, {}, options),
    },
    /**
     * A DAO's vote on one of this app's Treasury proposals under its DAO consent: `file` answers the proposal a member
     * files; `state` reads it until the DAO's signature is found and relayed to the agent. Then execute the proposal as
     * usual. Filing again files a new request: follow the one you have.
     */
    daoVotes: {
      file: (input: { organization: string; agent: string; proposal: string; verdict: "approve" | "reject" }, options?: AppRouteOptions) =>
        route("/dao-votes", appDaoVoteFiled, post(input), options),
      state: (id: string, options?: AppRouteOptions) => route(`/dao-votes/${encodeURIComponent(id)}`, appDaoVoteState, {}, options),
    },
    /** One Organization's agent: reads, owner actions and Treasury procedures its live consents cover. */
    agent(organization: string, agent: string) {
      const owner = ownerClient({ base: `${root}/apps/v1/o/${encodeURIComponent(organization)}/a/${encodeURIComponent(agent)}`, fetch: authorized });
      return {
        call<P extends Exclude<AppProcedure, AppStream>>(path: P, ...[input, options]: undefined extends AppInputs[P] ? [input?: AppInputs[P], options?: OwnerCallOptions] : [input: AppInputs[P], options?: OwnerCallOptions]): Promise<OwnerResult<OwnerOutput<P>>> {
          return (owner.call as (path: P, input?: unknown, options?: OwnerCallOptions) => Promise<OwnerResult<OwnerOutput<P>>>)(path, input, options);
        },
        /** A stream's events (`sweep`, and with `treasury-execute` `rebalance` and `executePlan`), as `ownerClient.stream` reads them. */
        stream<P extends AppStream>(path: P, input: AppInputs[P], options?: OwnerCallOptions): AsyncGenerator<OwnerOutput<P>, OwnerFailure | undefined> {
          return owner.stream(path, input as never, options);
        },
      };
    },
  };
}
export type AppClient = ReturnType<typeof appClient>;
