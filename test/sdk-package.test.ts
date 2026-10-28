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
