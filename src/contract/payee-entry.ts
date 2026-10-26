/**
 * `@multiagency/sdk/payee`: the payee side of the contract. It imports zod alone; the owner entry's oRPC and AG-UI
 * dependencies are installed but never loaded by this entry.
 */
export { contractPackage } from "./package-version.js";
export { payeeContract, compatiblePayeeFrontend, compatibleRelease } from "../payee-contract.js";
export * from "../compensation-contract.js";
export * from "./payee.js";
export * from "./client.js";
export * from "./agent-connection.js";
