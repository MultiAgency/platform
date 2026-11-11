import { limitOrderCreateInput, limitOrderQuoteInput, limitOrderRef, limitOrderSigned } from "../contract/limit-orders.js";
import { approveLimitOrder, cancelLimitOrder, createLimitOrder, getLimitOrder, listLimitOrders, placeLimitOrder,
  quoteLimitOrder, refreshLimitOrder, rejectLimitOrder } from "../limit-orders/service.js";
import { os } from "./base.js";
import { readOutput } from "./read-output.js";

/** Owner-signed Treasury limit orders, available to an app with the dedicated consent. */
export const limitOrderRoutes = {
  limitOrders: {
    quote: os.input(limitOrderQuoteInput).use(readOutput("limitOrders/quote")).handler(({ input, context }) => quoteLimitOrder(context, input)),
    create: os.input(limitOrderCreateInput).handler(({ input, context }) => createLimitOrder(context, input)),
    get: os.input(limitOrderRef).use(readOutput("limitOrders/get")).handler(({ input, context }) => getLimitOrder(context, input)),
    list: os.use(readOutput("limitOrders/list")).handler(({ context }) => listLimitOrders(context)),
    approve: os.input(limitOrderSigned).handler(({ input, context }) => approveLimitOrder(context, input)),
    reject: os.input(limitOrderSigned).handler(({ input, context }) => rejectLimitOrder(context, input)),
    place: os.input(limitOrderRef).handler(({ input, context }) => placeLimitOrder(context, input)),
    cancel: os.input(limitOrderRef).handler(({ input, context }) => cancelLimitOrder(context, input)),
    refresh: os.input(limitOrderRef).use(readOutput("limitOrders/refresh")).handler(({ input, context }) => refreshLimitOrder(context, input)),
  },
};
