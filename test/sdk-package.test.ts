import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleOrpcClient, bundleTesting } from "../scripts/sdk-stage.js";

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

test("the testing entry is one bundle importing only zod, @orpc/contract and node:crypto, exporting the payout double its declaration names", async t => {
  // Inside the repository, so the bundle's imports resolve as they would from the package's own dependencies.
  mkdirSync(".test-artifacts", { recursive: true });
  const staging = mkdtempSync(join(".test-artifacts", "sdk-testing-")); t.after(() => rmSync(staging, { recursive: true, force: true }));
  const { packages, sources } = bundleTesting(staging);
  const bundled = readFileSync(join(staging, "dist/testing/index.js"), "utf8");
  assert.deepEqual([...new Set([...bundled.matchAll(/^import\s[^;]*?from\s*"([^"]+)"/gm)].map(m => m[1]))].sort(), ["@orpc/contract", "node:crypto", "zod"]);
  assert.ok(sources.includes("src/authorize.ts") && sources.includes("src/mandate.ts"), "the platform's own rule and digest are inside");
  assert.deepEqual(sources.filter(file => /^src\/(agent|api|ops|lock|payout-requests|chain|recipients)\.ts$/.test(file)), [], "nothing of the money path's I/O is");
  assert.ok([...packages].some(dir => dir.endsWith("@orpc/server")));
  const testing = await import(join(process.cwd(), staging, "dist/testing/index.js")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(testing), ["payoutDouble"]);
  assert.match(readFileSync(join(staging, "dist/testing/index.d.ts"), "utf8"), /export declare const payoutDouble: PayoutDoubleFactory;/);
  for (const entry of ["src/contract/index.ts", "src/contract/payee-entry.ts", "src/contract/owner-contract.ts"])
    assert.doesNotMatch(readFileSync(entry, "utf8"), /testing/, `${entry} doesn't load the testing entry`);
});
