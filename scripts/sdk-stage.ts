// Stages @multiagency/sdk into a package directory from the same src/contract files Proto's handlers import. Used by
// contract-pack.ts (the per-release-candidate tarball) and sdk-dev.ts (the local `link:` directory apps develop against).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import * as contract from "../src/contract/index.js";

export const root = join(import.meta.dirname, "..");
export const { name, version } = contract.contractPackage;

export const run = (command: string, args: string[], cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
};

/** The compiler project for `dist`; `sdk-dev.ts` runs it in watch mode. */
export function writeTsconfig(path: string, staging: string) {
  writeFileSync(path, JSON.stringify({
    compilerOptions: { target: "ES2023", lib: ["ES2023", "DOM"], module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true,
      skipLibCheck: true, types: [], declaration: true, rootDir: join(root, "src"), outDir: join(staging, "dist") },
    files: [join(root, "src/contract/index.ts"), join(root, "src/contract/payee-entry.ts")],
  }, null, 2));
}

/** Copies the skills and change notes into `staging` (Intent reads skills only from inside the package, never through a symlink). */
export function copyGuidance(staging: string) {
  rmSync(join(staging, "skills"), { recursive: true, force: true });
  cpSync(join(root, "src/contract/skills"), join(staging, "skills"), { recursive: true });
  cpSync(join(root, "docs/sdk-changes.md"), join(staging, "CHANGES.md"));
}

/** Builds `staging` (emptied first) and returns the repository files it was built from. */
export function stage(staging: string, tsconfig: string) {
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  writeTsconfig(tsconfig, staging);
  run(join(root, "node_modules/.bin/tsc"), ["-p", tsconfig]);
  const emitted = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? emitted(join(dir, e.name)) : [join(dir, e.name)]);
  const sources = emitted(join(staging, "dist")).filter(f => f.endsWith(".js")).map(f => join("src", relative(join(staging, "dist"), f)).replace(/\.js$/, ".ts")).sort();

  // The shared release asset server ships as-is: plain ESM with no dependencies.
  mkdirSync(join(staging, "bin")); cpSync(join(root, "src/contract/release-server.mjs"), join(staging, "bin/release-server.mjs"));
  sources.push("src/contract/release-server.mjs");
  // TanStack Intent skills: the agent guidance for this exact version. Their maintenance artifacts stay unpublished.
  copyGuidance(staging);
  sources.push("docs/sdk-changes.md");
  sources.push(...readdirSync(join(root, "src/contract/skills"), { recursive: true, encoding: "utf8" }).filter(f => f.endsWith("/SKILL.md")).map(f => join("src/contract/skills", f)).sort());
  // JSON Schema for non-JavaScript consumers; refinements are enforced only by the zod schemas.
  mkdirSync(join(staging, "schemas"));
  const schemas: Record<string, z.ZodType> = { reportCommand: contract.reportCommand, payeeWorkOrderRequest: contract.payeeWorkOrderRequest, session: contract.session,
    invoicesView: contract.invoicesView, fileResult: contract.fileResult, workOrderList: contract.workOrderList, publicWorkOrder: contract.publicWorkOrder,
    workOrderRequestResult: contract.workOrderRequestResult, payeeCompensationView: contract.payeeCompensationView, requestRecord: contract.requestRecord,
    ownerCompensationView: contract.ownerCompensationView, compensationSend: contract.compensationSend, errorBody: contract.errorBody,
    agentConnection: contract.agentConnection, agentConnectionIssue: contract.agentConnectionIssue, agentConnectionStarted: contract.agentConnectionStarted,
    agentConnectionList: contract.agentConnectionList, treasurySummary: contract.summaryOutput };
  for (const [key, schema] of Object.entries(schemas)) writeFileSync(join(staging, "schemas", `${key}.json`), JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }), null, 2) + "\n");

  const dependencies = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies as Record<string, string>;
  writeFileSync(join(staging, "package.json"), JSON.stringify({ name, version, type: "module", license: "UNLICENSED", private: true,
    description: "MultiAgency SDK: payee, compensation and owner-app schemas, typed payee and owner clients, and the shared release asset server.",
    keywords: ["tanstack-intent"], repository: { type: "git", url: "git+https://github.com/MultiAgency/agentic-treasury-private.git" },
    exports: { ".": { types: "./dist/contract/index.d.ts", default: "./dist/contract/index.js" },
      "./payee": { types: "./dist/contract/payee-entry.d.ts", default: "./dist/contract/payee-entry.js" },
      "./schemas/*": "./schemas/*", "./release-server": "./bin/release-server.mjs" }, bin: { "proto-release-server": "./bin/release-server.mjs" },
    files: ["dist", "bin", "schemas", "skills", "!skills/_artifacts", "CHANGES.md", "provenance.json"],
    // zod is the one peer every entry needs; the owner peers are required only by the root entry (owner contract and client).
    peerDependencies: { zod: dependencies.zod, "@orpc/client": dependencies["@orpc/client"], "@orpc/contract": dependencies["@orpc/contract"], "@ag-ui/core": dependencies["@ag-ui/core"] },
    peerDependenciesMeta: { "@orpc/client": { optional: true }, "@orpc/contract": { optional: true }, "@ag-ui/core": { optional: true } } }, null, 2) + "\n");
  return sources;
}
