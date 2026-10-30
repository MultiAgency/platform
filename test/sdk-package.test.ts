import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleOrpcClient } from "../scripts/sdk-stage.js";

test("the packaged SDK carries its own oRPC client: no bare @orpc/client import for an app's bundler to share, with its licenses", async t => {
  const staging = mkdtempSync(join(tmpdir(), "sdk-package-")); t.after(() => rmSync(staging, { recursive: true, force: true }));
  mkdirSync(join(staging, "dist/contract"), { recursive: true });
  bundleOrpcClient(staging);
  const bundled = readFileSync(join(staging, "dist/contract/orpc-client.js"), "utf8");
  assert.doesNotMatch(bundled, /(from|import)\s*\(?\s*["']@orpc\//);
  const client = await import(join(staging, "dist/contract/orpc-client.js")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(client).sort(), ["ORPCError", "RPCLink", "createORPCClient"]);
  const notices = readFileSync(join(staging, "THIRD-PARTY-NOTICES"), "utf8");
  for (const name of ["@orpc/client", "@orpc/shared"]) assert.match(notices, new RegExp(`^${name}@\\S+ \\(MIT\\)`, "m"));
  assert.match(notices, /Permission is hereby granted/);
});

test("the SDK reaches oRPC's client only through its bundled module", () => {
  const files = readdirSync("src/contract", { recursive: true, encoding: "utf8" }).filter(f => /\.(ts|mts)$/.test(f) && f !== "orpc-client.ts");
  assert.ok(files.includes("owner-client.ts"));
  for (const file of files) assert.doesNotMatch(readFileSync(join("src/contract", file), "utf8"), /from "@orpc\/client/, file);
});

test("the main and payee entries load no oRPC package but the bundled client: only @multiagency/sdk/contract loads @orpc/contract", () => {
  // Every module reachable through relative imports (type-only imports included, as a superset) from an entry.
  const reachable = (entry: string) => {
    const seen = new Set<string>(), queue = [entry];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g))
        queue.push(join(file, "..", spec!.replace(/\.js$/, ".ts")).replace(/\.mjs$/, ".mjs"));
    }
    return [...seen];
  };
  const loadsContract = (file: string) => /^import\s+(?!type\b)[^;]*from\s+"@orpc\/(contract|server)/m.test(readFileSync(file, "utf8"));
  for (const entry of ["src/contract/index.ts", "src/contract/payee-entry.ts"]) {
    const files = reachable(entry);
    assert.ok(files.length > 5, entry);
    assert.deepEqual(files.filter(loadsContract), [], `${entry} reaches no module importing @orpc/contract or @orpc/server`);
  }
  assert.ok(loadsContract("src/contract/owner-contract.ts"), "the contract subpath does load it");
});
