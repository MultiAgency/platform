/**
 * The oRPC client the SDK runs on. The published package carries this module bundled (`scripts/sdk-stage.ts`), so an
 * app whose bundler shares `@orpc/client` (Module Federation shares bare names only) never mixes its copy with the SDK's
 * link: the SDK's behaviour doesn't depend on the oRPC version the app happens to ship. In this repository it resolves to
 * the installed packages.
 */
export { createORPCClient, ORPCError } from "@orpc/client";
export { RPCLink } from "@orpc/client/fetch";
