import { defineConfig } from "@rsbuild/core";
import { join } from "node:path";

// The example as a product would build it: bundled with its dependencies, served by the Proto gateway as a static
// frontend. Inside the Proto checkout `@multiagency/sdk` resolves to the SDK's own source; a product installs the package.
export default defineConfig({
  source: { entry: { index: "./app.ts" } },
  resolve: { alias: { "@multiagency/sdk": join(import.meta.dirname, "../../src/contract/index.ts") } },
  html: { template: "./index.html" },
  output: { distPath: { root: process.env.EXAMPLE_DIST ?? "dist" }, copy: [{ from: "./contract.json" }] },
});
