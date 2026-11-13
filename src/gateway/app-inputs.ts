/** Request validation for the app gateway; authorization remains in the route handlers. */
import { z } from "zod";
import { limitOrderId } from "../contract/limit-orders.js";
import { hireTerms, marketBrief, payoutRequestId } from "../contract/inputs.js";
import { setupRequest } from "./hosted-agents.js";

const organizationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const agentName = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** `GET /apps/v1/agents`: an Organization's reservations, narrowed by the owner and area a setup names. */
export const reservationQuery = z.strictObject({ organization: organizationId,
  owner: setupRequest.shape.owner.optional(), area: setupRequest.shape.area.optional() });
export const daoConsentFiling = z.strictObject({ message: z.string().min(1).max(2_048) });
/** A DAO's approval of one market hire, as an app asks for it: the terms it quoted, the brief, and how long the approval may last. */
export const daoHireFiling = z.strictObject({ organization: organizationId, agent: agentName,
  requestId: payoutRequestId, brief: marketBrief, approved: hireTerms, validUntil: z.iso.datetime(),
  recoverProposal: z.literal("dao-checked").optional() });
export const daoVoteFiling = z.strictObject({ organization: organizationId, agent: agentName,
  proposal: z.string().min(1).max(128), verdict: z.enum(["approve", "reject"]) });
export const daoOrderFiling = z.strictObject({ organization: organizationId, agent: agentName,
  order: limitOrderId, verdict: z.enum(["approve", "reject"]) });
