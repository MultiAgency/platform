import { z } from "zod";

/**
 * What a hosted agent is for. Presentation and setup identity only: the owner-signed policy, the grant and role checks
 * still govern every action. `market` hires agents on the NEAR AI Agent Market over x402 (docs/market.md); it is set up
 * by an app only, never through the owner frontend's self-service.
 */
export const AREAS = ["treasury", "payables", "market"] as const;
export type Area = (typeof AREAS)[number];
export const area = z.enum(AREAS);

/** The areas the owner frontend sets up and shows in its walkthroughs and demo hosts. */
export const FRONTEND_AREAS = ["treasury", "payables"] as const satisfies readonly Area[];
export const frontendArea = z.enum(FRONTEND_AREAS);
export type FrontendArea = (typeof FRONTEND_AREAS)[number];
export const isFrontendArea = (value: Area): value is FrontendArea => (FRONTEND_AREAS as readonly Area[]).includes(value);
