import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runtimeImports } from "./fixtures/source-analysis.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every repo module the invoice host can load, following relative imports from its entry. */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const stack = [join(root, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    for (const spec of runtimeImports(source, file)) {
      if (spec.startsWith(".")) stack.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

/** The role reads src/chain.ts offers; the dashboard calls them, the invoice host must not. */
const ROLE_READS = /\b(daoPolicy|describeTreasury|council|permits|groupOf)\(|get_policy/;

/**
 * Requesters never learn the roster: the invoice host never reads the DAO's roles. Pinned at the source
 * of everything it can load, so a role read added anywhere on its path fails here. chain.ts, which
 * defines the reads for the dashboard, is on the path for other lookups and is left out, as is
 * contract/dao-roles.ts: pure functions over a policy they are given, which read nothing.
 */
test("nothing the invoice host loads reads the DAO's roles", () => {
  const modules = reachable("src/invoice-http.ts");
  for (const file of ["src/invoices.ts", "src/invoice-store.ts"])
    assert.ok(modules.has(join(root, file)), `The import walk must reach ${file}`);
  const offenders = [...modules]
    .map(([file, source]) => [relative(root, file), source] as const)
    .filter(([name, source]) => !["src/chain.ts", "src/contract/dao-roles.ts"].includes(name) && (/gateway\/roles\.ts$/.test(name) || ROLE_READS.test(source)))
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
});
