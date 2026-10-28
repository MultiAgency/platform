import { createORPCClient, ORPCError, RPCLink } from "./orpc-client.js";
import type { z } from "zod";
import { ownerOutputs, ownerStreams } from "./owner-outputs.js";
import type { OwnerInputs } from "./owner-inputs.js";
import { gatewayDenialScope, type GatewayDenialScope } from "./gateway.js";
import { READS } from "./permissions.js";

export type OwnerProcedure = keyof typeof ownerOutputs & keyof OwnerInputs;
type Stream = (typeof ownerStreams)[number];
export type OwnerOutput<P extends OwnerProcedure> = z.output<(typeof ownerOutputs)[P]>;
type Identity = Record<string, unknown>;
/** Supplementary provider facts on a `provider` failure (not retry flags or authorization decisions). */
export type RefusalDetails = { availableAt?: string; budgetRemainingUsd?: string };
/** Per-call options: an aborted read is `unavailable`; an aborted mutation or stream is `unknown` (it may have been accepted). */
export type OwnerCallOptions = { signal?: AbortSignal };

/**
 * Recovery is decided by `kind`, never by message text.
 * - `session` (401) / `forbidden` (403): from the status alone, with the `source` that refused. A gateway denial adds the `scope` it declares (no
 *   session, no access to this agent, or no permission for this procedure); without one, the caller picks its default.
 * - `unresolved` / `busy`: refused before anything was sent; follow existing operations, then try again.
 * - `refused`: the platform refused before sending (with `code` when it names a reason).
 * - `provider`: the provider refused or failed; check the recorded outcome before retrying.
 * - `unavailable`: a read failed or returned an invalid answer; reading again is safe.
 * - `unknown`: a mutation or stream may have taken effect. Keep `identity`, read the existing records, never resend.
 * `refused` keeps the HTTP `status` and oRPC `rpcCode` of the encoded refusal. A plain answer that isn't an encoded
 * oRPC error (a proxy page, or a 404 for a procedure this host lacks) adds its `httpStatus` to `unavailable` or
 * `unknown`, for diagnosis only: nothing in it proves the handler didn't run, so it never becomes `refused`.
 */
export type OwnerFailure =
  | { ok: false; kind: "session"; status: 401; error: string; source?: DenialSource; scope?: GatewayDenialScope }
  | { ok: false; kind: "forbidden"; status: 403; error: string; source?: DenialSource; scope?: GatewayDenialScope }
  | { ok: false; kind: "unresolved" | "busy"; error: string }
  | { ok: false; kind: "refused"; error: string; code?: string; status?: number; rpcCode?: string }
  | { ok: false; kind: "provider"; error: string; code?: string; details: RefusalDetails }
  | { ok: false; kind: "unavailable"; httpStatus?: number }
  | { ok: false; kind: "unknown"; procedure: OwnerProcedure; identity: Identity; httpStatus?: number };
/** Who refused: the gateway (a plain answer, before forwarding) or the agent server (an encoded oRPC error). */
export type DenialSource = "gateway" | "agent";
export type OwnerResult<T> = { ok: true; value: T } | OwnerFailure;

/** oRPC codes that mean the server refused before acting. TIMEOUT and CLIENT_CLOSED_REQUEST are not: the outcome is unknown. */
const REFUSALS = new Set(["BAD_REQUEST", "NOT_FOUND", "METHOD_NOT_SUPPORTED", "NOT_ACCEPTABLE", "CONFLICT", "PRECONDITION_FAILED", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "UNPROCESSABLE_CONTENT", "TOO_MANY_REQUESTS"]);
/**
 * An encoded oRPC error from any copy of `@orpc/client`. A bundler can load the link's copy apart from this module's
 * (Module Federation shares `@orpc/client` but not `@orpc/client/fetch`; seen in the dashboard's built API), and
 * `instanceof ORPCError` then fails across them, turning a proven refusal into `unknown`. Every version names its error
 * `ORPCError` and carries a string `code`.
 */
const isRpcError = (error: unknown): error is Pick<ORPCError<string, unknown>, "code" | "message" | "data"> =>
  error instanceof ORPCError || (error instanceof Error && error.name === "ORPCError" && typeof (error as { code?: unknown }).code === "string");
/** A non-2xx answer that isn't an encoded oRPC error. */
class PlainAnswer extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
class GatewayDenial extends Error { constructor(readonly status: 401 | 403, message: string, readonly scope?: GatewayDenialScope) { super(message); } }
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Where owner procedures live: `""` or `/a/<agent>` on the page's own host (the gateway session cookie goes same-origin),
 * or an absolute URL for a caller outside a browser, such as Treasury's scoped machine route
 * `https://<host>/machine/v1/a/<agent>`. The client adds no credential: a non-browser caller's `fetch` adds the one its
 * route accepts. A Treasury machine credential is accepted only on that machine route, never on `/a/<agent>/rpc`, and
 * there is no Payables or DAO machine delegation.
 */
export type OwnerBase = "" | `/${string}` | `https://${string}` | `http://${string}`;

/** Typed owner procedures under an agent base (see OwnerBase), same wire as the app's oRPC client. Never retries. */
export function ownerClient({ base = "", fetch: send = globalThis.fetch }: { base?: OwnerBase; fetch?: Fetch } = {}) {
  /** One call's client: it records that call's HTTP status, which oRPC's errors don't carry. */
  const procedure = (path: string, answered: (status: number) => void) => {
    // oRPC's URL type omits `http://`; the link only concatenates it and hands it to `fetch` below.
    const client = createORPCClient(new RPCLink({ url: `${base}/rpc` as `/${string}`, fetch: (url, init) => answer(url, init, answered) })) as unknown as Record<string, unknown>;
    return path.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], client) as (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  };
  async function answer(url: string | URL, init: RequestInit, answered: (status: number) => void) {
    // Same origin in a browser; outside one, relative paths resolve against localhost (tests and tools pass their own fetch).
    const response = await send(new URL(url, globalThis.location?.href ?? "http://localhost"), init);
    answered(response.status);
    if (response.ok) return response;
    // Gateway denials are plain JSON, not encoded RPC errors; the status alone decides. Any other plain answer keeps
    // only its status: it is classified as lost below.
    const body = await response.clone().json().catch(() => null) as { error?: unknown; json?: { code?: unknown } } | null;
    if (typeof body?.json?.code === "string") return response;
    if (response.status === 401 || response.status === 403)
      throw new GatewayDenial(response.status, typeof body?.error === "string" ? body.error : response.status === 401 ? "Sign in again." : "This account may not do that.", gatewayDenialScope(body));
    throw new PlainAnswer(response.status);
  }

  function failure(error: unknown, path: OwnerProcedure, identity: Identity, status?: number): OwnerFailure {
    const mutation = !READS.has(path);
    const lost: OwnerFailure = mutation ? { ok: false, kind: "unknown", procedure: path, identity } : { ok: false, kind: "unavailable" };
    if (error instanceof GatewayDenial) {
      const scope = error.scope && { scope: error.scope };
      return error.status === 401 ? { ok: false, kind: "session", status: 401, error: error.message, source: "gateway", ...scope }
        : { ok: false, kind: "forbidden", status: 403, error: error.message, source: "gateway", ...scope };
    }
    if (error instanceof PlainAnswer) return error.status > 0 ? { ...lost, httpStatus: error.status } : lost;
    if (!isRpcError(error)) return lost;
    if (error.code === "UNAUTHORIZED") return { ok: false, kind: "session", status: 401, error: error.message, source: "agent" };
    if (error.code === "FORBIDDEN") return { ok: false, kind: "forbidden", status: 403, error: error.message, source: "agent" };
    const data = (error.data ?? {}) as { kind?: unknown; code?: unknown; availableAt?: unknown; budgetRemainingUsd?: unknown };
    const code = typeof data.code === "string" ? data.code : undefined;
    if (data.kind === "unresolved" || data.kind === "busy") return { ok: false, kind: data.kind, error: error.message };
    const refusal = { ...(status !== undefined && { status }), rpcCode: error.code };
    if (data.kind === "refused") return { ok: false, kind: "refused", error: error.message, ...(code && { code }), ...refusal };
    if (data.kind === "provider") return { ok: false, kind: "provider", error: error.message, ...(code && { code }), details: {
      ...(typeof data.availableAt === "string" && { availableAt: data.availableAt }),
      ...(typeof data.budgetRemainingUsd === "string" && { budgetRemainingUsd: data.budgetRemainingUsd }) } };
    // Untyped refusal codes come before the handler acted (input validation, not found); anything else may follow an effect.
    return REFUSALS.has(error.code) ? { ok: false, kind: "refused", error: error.message, ...(code && { code }), ...refusal } : lost;
  }

  return {
    /** One read or non-stream mutation; the answer is validated against the published output schema. */
    async call<P extends Exclude<OwnerProcedure, Stream>>(path: P, ...[input, options]: OwnerInputs[P] extends undefined ? [input?: undefined, options?: OwnerCallOptions] : [input: OwnerInputs[P], options?: OwnerCallOptions]): Promise<OwnerResult<OwnerOutput<P>>> {
      const identity = (input ?? {}) as Identity;
      let output: unknown;
      let status: number | undefined;
      try { output = await procedure(path, answered => { status = answered; })(input, { signal: options?.signal }); } catch (error) { return failure(error, path, identity, status); }
      const parsed = ownerOutputs[path].safeParse(output);
      if (parsed.success) return { ok: true, value: parsed.data as OwnerOutput<P> };
      return READS.has(path) ? { ok: false, kind: "unavailable" } : { ok: false, kind: "unknown", procedure: path, identity };
    },
    /** A stream's events, each validated; a lost stream or invalid event ends it as `unknown` with the input identity. */
    async *stream<P extends Stream>(path: P, input: OwnerInputs[P], options?: OwnerCallOptions): AsyncGenerator<OwnerOutput<P>, OwnerFailure | undefined> {
      const identity = (input ?? {}) as Identity;
      let events: AsyncIterable<unknown>;
      let status: number | undefined;
      try { events = await procedure(path, answered => { status = answered; })(input, { signal: options?.signal }) as AsyncIterable<unknown>; } catch (error) { return failure(error, path, identity, status); }
      let started = false;
      const iterator = events[Symbol.asyncIterator]();
      // An open stream must end on abort even if the transport keeps it open: race each read with the signal.
      const aborted = new Promise<"aborted">(resolve => {
        if (options?.signal?.aborted) resolve("aborted");
        options?.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next === "aborted") { void iterator.return?.(); return { ok: false, kind: "unknown", procedure: path, identity }; }
          if (next.done) break;
          started = true;
          const parsed = ownerOutputs[path].safeParse(next.value);
          if (!parsed.success) { void iterator.return?.(); return { ok: false, kind: "unknown", procedure: path, identity }; }
          yield parsed.data as OwnerOutput<P>;
        }
      } catch (error) {
        // After any event, part of the stream may have taken effect: only a failure before the first event keeps its kind.
        return started ? { ok: false, kind: "unknown", procedure: path, identity } : failure(error, path, identity, status);
      }
      return undefined;
    },
  };
}
export type OwnerClient = ReturnType<typeof ownerClient>;
