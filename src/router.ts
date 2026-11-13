import { compensationRoutes } from "./rpc/compensation.js";
import { ownerRoutes } from "./rpc/owner.js";
import { payablesRoutes } from "./rpc/payables.js";
import { marketRoutes } from "./rpc/market.js";
import { treasuryRoutes } from "./rpc/treasury.js";
import { observationsRoutes } from "./rpc/observations.js";
import { workOrderRoutes } from "./rpc/work-orders.js";
import { proposalRoutes } from "./rpc/proposals.js";
import { limitOrderRoutes } from "./rpc/limit-orders.js";

/** Public procedure names stay stable; each module owns one responsibility. */
export const router = {
  ...compensationRoutes,
  ...ownerRoutes,
  ...payablesRoutes,
  ...treasuryRoutes,
  ...observationsRoutes,
  ...workOrderRoutes,
  ...proposalRoutes,
  ...limitOrderRoutes,
  ...marketRoutes,
};

export type Router = typeof router;
