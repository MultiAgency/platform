// The local @multiagency/sdk apps develop against: `packages/sdk`, linked with pnpm `link:`. It is staged once (package.json,
// bin, JSON Schemas); then `dist` is kept current by the compiler in watch mode, and the skills and change notes are
// recopied when they change. Rerun after changing a JSON-Schema-exported schema or the release server.
// Usage: pnpm sdk:dev            (stage, then watch)
//        pnpm sdk:dev --once     (stage only)
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { copyGuidance, root, stage } from "./sdk-stage.js";

const staging = join(root, "packages/sdk"), tsconfig = join(root, "packages/sdk.tsconfig.json");
stage(staging, tsconfig);
console.log(`@multiagency/sdk staged at ${staging}`);
if (!process.argv.includes("--once")) {
  for (const path of [join(root, "src/contract/skills"), join(root, "docs/sdk-changes.md"), join(root, "src/contract/README.md")])
    watch(path, { recursive: true }, () => { copyGuidance(staging); console.log("skills and change notes recopied"); });
  spawn(join(root, "node_modules/.bin/tsc"), ["-p", tsconfig, "--watch", "--preserveWatchOutput"], { stdio: "inherit" }).on("exit", code => process.exit(code ?? 0));
}
