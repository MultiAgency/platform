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
export * from "./owner-outputs.js";
export * from "./owner-client.js";
export * from "./app-consent.js";
export * from "./app-access.js";
export * from "./app-client.js";
export type { OwnerInputs, OwnerAction } from "./owner-inputs.js";
export * from "./inputs.js";
export { ASSETS } from "./assets.js";
export { intentsAccount, isNearcomAddress, validIntentsAccount } from "./intents-account.js";
export { mayCall, type Access } from "./permissions.js";
export * from "./gateway.js";
export * from "./proposals.js";
export * from "./run-progress-schema.js";
export { RecordingSchema, MAX_RECORDING_BYTES, AGUI_VERSION, AGUI_PROTOCOL_VERSION, type Recording, type RunLogEvent } from "./run-log-schema.js";
