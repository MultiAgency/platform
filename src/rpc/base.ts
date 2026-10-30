import { CompensationError } from "../compensation-store.js";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { implement, ORPCError, os as base } from "@orpc/server";
import { ownerContract } from "../contract/owner-contract.js";
import { refusalDetails } from "../provider-display.js";
import { PublicError } from "../public-error.js";
import { MoneyLockBusy, UnresolvedOperations } from "../lock.js";
import { WorkOrderRefusal } from "../work-order-protocol.js";
import { AuthorizationHeld, provenRefusal } from "../ops.js";
import { READS } from "../contract/permissions.js";
/**
 * Only explicitly constructed ORPCErrors/PublicErrors are public application messages. Arbitrary exceptions
 * and provider detail/title text may contain credentials or private paths, even for admitted owners.
 * Provider codes and validated refusal metadata remain available for UI recovery guidance.
 */
function toClientError(error: unknown, procedure: string) {
  // Typed recovery kinds (`data.kind`), all raised before anything is sent: clients branch on kind, never on text.
  if (error instanceof UnresolvedOperations)
    return new ORPCError("CONFLICT", { message: "Earlier money actions have no proven outcome, so nothing new was sent. Follow the existing operations before another action.", data: { kind: "unresolved" } });
  if (error instanceof MoneyLockBusy) return new ORPCError("CONFLICT", { message: error.message, data: { kind: "busy" } });
  if (error instanceof CompensationError) return new ORPCError(error.code === "not_found" ? "NOT_FOUND" : "CONFLICT", { message: error.message, data: { kind: "refused", code: error.code } });
  if (error instanceof ORPCError) return error;
  if (error instanceof WorkOrderRefusal) return new ORPCError("BAD_REQUEST", { message: error.message, data: { kind: "refused", code: error.code } });
  if (error instanceof PublicError) return new ORPCError("BAD_REQUEST", { message: error.message, data: { kind: "refused" } });
  // Held by this server's own checks before anything reached the provider (a vote's approval check, a send's local
  // checks, which the journal records as `local_authorization_held`): proven not to have taken effect.
  if (error instanceof AuthorizationHeld)
    return new ORPCError("BAD_REQUEST", { message: error.message, data: { kind: "refused", code: "local_authorization_held" } });
  // A provider failure is a typed refusal only where it cannot hide an effect: on a read, or when the provider's
  // answer proves nothing executed. Anything else after a mutation may follow a submission and stays untyped
  // (the client reports `unknown` with the request's identity and never resends).
  if (error instanceof AgentApiError && (READS.has(procedure) || provenRefusal(error)))
    return new ORPCError("BAD_REQUEST", { message: "The provider could not complete this request. Check the recorded outcome before retrying.", data: { kind: "provider", code: error.code, availableAt: null, ...refusalDetails(error) } });
  return new ORPCError("INTERNAL_SERVER_ERROR", { message: "The request could not be completed. Check existing records before retrying an action." });
}

/** Converts every failure to its public form, including a stream's, which is thrown after next() resolves. */
const clientErrors = base.$context<{ actor?: string }>().middleware(async ({ next, path }) => {
  const procedure = path.join("/");
  try {
    const result = await next();
    const output: unknown = result.output;
    if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return result;
    const stream = output as AsyncIterable<unknown>;
    async function* converted() {
      try {
        yield* stream;
      } catch (error) {
        throw toClientError(error, procedure);
      }
    }
    return { ...result, output: converted() as typeof result.output };
  } catch (error) {
    throw toClientError(error, procedure);
  }
});

export const os = base.$context<{ actor?: string }>().use(clientErrors);
/**
 * Procedures implemented from the published owner contract. Output validation is off: oRPC would otherwise parse
 * (and strip) every answer. Reads add `readOutput` (validate only); mutations and streams are not validated here.
 */
export const owner = implement(ownerContract).$context<{ actor?: string }>().$config({ disableOutputValidation: true }).use(clientErrors);
