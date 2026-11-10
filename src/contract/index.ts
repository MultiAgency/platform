/**
 * @multiagency/sdk: the platform contract apps compile against instead of copying the platform.
 * The platform's own handlers import these modules; the package is packed from the same files.
 * `@multiagency/sdk/payee` is the payee side alone (zod only), for apps without owner procedures.
 */
export { contractPackage } from "./package-version.js";
export { payeeContract, compatiblePayeeFrontend, compatibleRelease } from "../payee-contract.js";
export * from "./owner-capabilities.js";
export * from "../compensation-contract.js";
export * from "./payee.js";
export * from "./client.js";
export * from "./agent-connection.js";
export * from "./payee-policy.js";
export * from "./owner-outputs.js";
export * from "./owner-client.js";
export * from "./app-consent.js";
export * from "./app-access.js";
export * from "./app-client.js";
export * from "./dao-roles.js";
export { fundingTransaction, registrationTransaction } from "./funding.js";
export type { OwnerInputs, OwnerAction } from "./owner-inputs.js";
export * from "./inputs.js";
export { ASSETS } from "./assets.js";
export { intentsAccount, isNearcomAddress, validIntentsAccount } from "./intents-account.js";
export { mayCall, type Access } from "./permissions.js";
export * from "./gateway.js";
export { AREAS, FRONTEND_AREAS, type Area } from "./areas.js";
export { hireText, marketApproveInput, MAX_HIRE_APPROVAL_MS } from "./market.js";
export * from "./proposals.js";
export * from "./treasury-proposals.js";
export * from "./run-progress-schema.js";
export { RecordingSchema, MAX_RECORDING_BYTES, AGUI_VERSION, AGUI_PROTOCOL_VERSION, type Recording, type RunLogEvent } from "./run-log-schema.js";

export * from "./agent-release.js";
