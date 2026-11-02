import { proposalCreateInput, proposalRef, proposalSigned } from "../contract/treasury-proposals.js";
import { approveProposal, createProposal, executeProposal, getProposal, listProposals, rejectProposal, withdrawProposal } from "../proposals/service.js";
import { os } from "./base.js";
import { readOutput } from "./read-output.js";

/** Treasury proposals, through an app only (src/proposals/service.ts; docs/enforcement.md, "Treasury proposals"). */
export const proposalRoutes = {
  proposals: {
    create: os.input(proposalCreateInput).handler(({ input, context }) => createProposal(context, input)),
    get: os.input(proposalRef).use(readOutput("proposals/get")).handler(({ input, context }) => getProposal(context, input)),
    list: os.use(readOutput("proposals/list")).handler(({ context }) => listProposals(context)),
    approve: os.input(proposalSigned).handler(({ input, context }) => approveProposal(context, input)),
    reject: os.input(proposalSigned).handler(({ input, context }) => rejectProposal(context, input)),
    withdraw: os.input(proposalRef).handler(({ input, context }) => withdrawProposal(context, input)),
    execute: os.input(proposalRef).handler(({ input, context }) => executeProposal(context, input)),
  },
};
