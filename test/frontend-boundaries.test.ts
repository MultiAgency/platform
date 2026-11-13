import "../web/src/features/payables/payment-stages.test.js";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runtimeImports } from "./fixtures/source-analysis.mjs";

const web = fileURLToPath(new URL("../web/src/", import.meta.url));
function runtimeDependencies(entry: string, seen = new Set<string>()) {
  const file = resolve(web, entry);
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  for (const specifier of runtimeImports(source, file)) {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
    const base = (specifier.startsWith("@/") ? resolve(web, specifier.slice(2)) : resolve(dirname(file), specifier)).replace(/\.js$/, "");
    const dependency = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(existsSync);
    assert.ok(dependency, `Unresolved local runtime dependency: ${specifier} in ${file}`);
    runtimeDependencies(dependency, seen);
  }
  return seen;
}
test("generic UI primitives have no permission or transport dependency", () => {
  const dependencies = runtimeDependencies("shared/ui.tsx");
  for (const file of dependencies) assert.doesNotMatch(file, /\/(?:client|queries|viewer|wallet|owner|confirm-button)\.[tj]sx?$/);
});
