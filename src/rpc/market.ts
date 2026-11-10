import { marketHireInput, marketQuoteInput, marketStatusInput } from "../contract/inputs.js";
import { marketApproveInput } from "../contract/market.js";
import { approveHire, hire, hireStatus, marketAccount, quoteHire } from "../market/hire.js";
import { os } from "./base.js";
import { readOutput } from "./read-output.js";

/** Hires on the NEAR AI Agent Market over x402 (docs/market.md), under the caller's own `requestId`. */
export const marketRoutes = {
  market: {
    quote: os.use(readOutput("market/quote")).input(marketQuoteInput).handler(({ input }) => quoteHire(input)),
    hire: os.input(marketHireInput).handler(({ input, context }) => hire(context.actor, input)),
    status: os.use(readOutput("market/status")).input(marketStatusInput).handler(({ input, context }) => hireStatus(context.actor, input.requestId)),
    account: os.use(readOutput("market/account")).handler(() => marketAccount()),
    /** A DAO's signed approval of one hire, relayed by the platform (`/apps/v1/dao-hires`); then the hire is paid once. */
    approve: os.input(marketApproveInput).handler(({ input, context }) => approveHire(context, input)),
  },
};
