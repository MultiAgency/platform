import { compensationRoutes } from "./rpc/compensation.js";
import { ownerRoutes } from "./rpc/owner.js";
import { payablesRoutes } from "./rpc/payables.js";
import { treasuryRoutes } from "./rpc/treasury.js";
import { observationsRoutes } from "./rpc/observations.js";
import { workOrderRoutes } from "./rpc/work-orders.js";
import { demoGuideRoutes } from "./rpc/demo-guide.js";
import { proposalRoutes } from "./rpc/proposals.js";

/** Public procedure names stay stable; each module owns one responsibility. */
export const router = {
  ...compensationRoutes,
  ...ownerRoutes,
  ...payablesRoutes,
  ...treasuryRoutes,
  ...observationsRoutes,
  ...workOrderRoutes,
  ...demoGuideRoutes,
  ...proposalRoutes,
};

export type Router = typeof router;
