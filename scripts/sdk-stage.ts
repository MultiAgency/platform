// Stages @multiagency/sdk into a package directory from the same src/contract files the platform's handlers import. Used by
// contract-pack.ts (the per-release-candidate tarball) and sdk-dev.ts (the local `link:` directory apps develop against).
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import * as contract from "../src/contract/index.js";

export const root = join(import.meta.dirname, "..");
export const { name, version } = contract.contractPackage;
/** The oldest zod the SDK is tested on (offline suite and typecheck on 4.6.5, 2026-10-30), not the repository's own. */
export const ZOD_PEER = "^4.6.5";
/** The release server's command. */
export const releaseServerBins = { "multiagency-release-server": "bin/release-server.mjs" };

export const run = (command: string, args: string[], cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trimEnd();
};

/** The compiler project for `dist`; `sdk-dev.ts` runs it in watch mode. */
export function writeTsconfig(path: string, staging: string) {
  writeFileSync(path, JSON.stringify({
    compilerOptions: { target: "ES2023", lib: ["ES2023", "DOM"], module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true,
      skipLibCheck: true, types: [], declaration: true, rootDir: join(root, "src"), outDir: join(staging, "dist") },
    files: [join(root, "src/contract/index.ts"), join(root, "src/contract/payee-entry.ts"), join(root, "src/contract/owner-contract.ts"), join(root, "src/testing/types.ts")],
  }, null, 2));
}

/** Copies the skills, change notes, README and license into `staging` (Intent reads skills only from inside the package, never through a symlink). */
export function copyGuidance(staging: string) {
  rmSync(join(staging, "skills"), { recursive: true, force: true });
  cpSync(join(root, "src/contract/skills"), join(staging, "skills"), { recursive: true });
  cpSync(join(root, "docs/sdk-changes.md"), join(staging, "CHANGES.md"));
  cpSync(join(root, "src/contract/README.md"), join(staging, "README.md"));
  cpSync(join(root, "LICENSE"), join(staging, "LICENSE"));
}

/**
 * Bundles `entry` into `out` with esbuild; answers the packages it carried, each by its directory, and the repository
 * files it was built from.
 */
function bundle(entry: string, out: string, { platform, external = [] }: { platform: "neutral" | "node"; external?: string[] }) {
  const { metafile } = buildSync({ entryPoints: [join(root, entry)], outfile: out, bundle: true, format: "esm", platform, target: "es2023",
    mainFields: ["module", "main"], conditions: ["import"], legalComments: "inline", allowOverwrite: true, metafile: true, logLevel: "error", external });
  const inputs = Object.keys(metafile.inputs).map(input => relative(root, resolve(process.cwd(), input)));
  return {
    packages: new Set(inputs.flatMap(input => { const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//); return match ? [resolve(root, match[1]!)] : []; })),
    sources: inputs.filter(input => !input.includes("node_modules/")),
  };
}

/** THIRD-PARTY-NOTICES: each bundled package's license, and which of the package's files carry it. */
function writeNotices(staging: string, bundles: Record<string, Set<string>>) {
  const carriers = new Map<string, string[]>();
  for (const [file, packages] of Object.entries(bundles)) for (const dir of packages) carriers.set(dir, [...carriers.get(dir) ?? [], file]);
  const notices = [...carriers.keys()].sort().map(dir => {
    const { name: pkg, version: release, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license: string };
    const text = readdirSync(dir).find(file => /^licen[cs]e/i.test(file));
    if (!text) throw new Error(`${pkg} has no license file to carry`);
    return `${pkg}@${release} (${license}), bundled in ${carriers.get(dir)!.join(" and ")}\n\n${readFileSync(join(dir, text), "utf8").trim()}\n`;
  });
  writeFileSync(join(staging, "THIRD-PARTY-NOTICES"), notices.join("\n" + "-".repeat(78) + "\n\n"));
}

const ORPC_CLIENT = "dist/contract/orpc-client.js", TESTING = "dist/testing/index.js";

/**
 * Replaces the emitted `orpc-client` re-export with one self-contained module: the SDK's own oRPC client and fetch link,
 * with no bare `@orpc/*` import left for an app's bundler to share. Its types stay internal (no published declaration
 * names them). Writes the licenses of the packages it bundled into THIRD-PARTY-NOTICES, and answers those packages.
 */
export function bundleOrpcClient(staging: string) {
  const out = join(staging, ORPC_CLIENT);
  const { packages } = bundle("src/contract/orpc-client.ts", out, { platform: "neutral" });
  rmSync(join(staging, "dist/contract/orpc-client.d.ts"), { force: true });
  if (/(from|import)\s*\(?\s*["']@orpc\//.test(readFileSync(out, "utf8"))) throw new Error("The bundled oRPC client still imports @orpc/*");
  writeNotices(staging, { [ORPC_CLIENT]: packages });
  return packages;
}

/**
 * `@multiagency/sdk/testing`, for an app's own tests (Node): the payout double, bundled with what it runs from the
 * platform (`authorize`, the mandate digest and the payout policy template, all pure) and the oRPC server that answers
 * the app's client over the same wire. zod (the peer) and `@orpc/contract` (a dependency) stay imports. Its declaration
 * names only the public types emitted from src/testing/types.ts, never the platform modules inside the bundle.
 */
export function bundleTesting(staging: string) {
  const bundled = bundle("src/testing/payout-double.ts", join(staging, TESTING), { platform: "node", external: ["zod", "@orpc/contract"] });
  writeFileSync(join(staging, "dist/testing/index.d.ts"), [
    'import type { PayoutDoubleFactory } from "./types.js";', 'export type * from "./types.js";',
    "/** An in-process stand-in for one app's payout agent behind `/apps/v1`: the app-server skill, \"Test without the platform\". */",
    "export declare const payoutDouble: PayoutDoubleFactory;", ""].join("\n"));
  return bundled;
}

/** Builds `staging` (emptied first) and returns the repository files it was built from. */
export function stage(staging: string, tsconfig: string) {
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  writeTsconfig(tsconfig, staging);
  run(join(root, "node_modules/.bin/tsc"), ["-p", tsconfig]);
  const emitted = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? emitted(join(dir, e.name)) : [join(dir, e.name)]);
  const sources = emitted(join(staging, "dist")).filter(f => f.endsWith(".js")).map(f => join("src", relative(join(staging, "dist"), f)).replace(/\.js$/, ".ts")).sort();
  const testing = bundleTesting(staging);
  writeNotices(staging, { [ORPC_CLIENT]: bundleOrpcClient(staging), [TESTING]: testing.packages });
  sources.push(...testing.sources.filter(file => !sources.includes(file)));

  // The shared release asset server ships as-is: plain ESM with no dependencies.
  mkdirSync(join(staging, "bin")); cpSync(join(root, "src/contract/release-server.mjs"), join(staging, "bin/release-server.mjs"));
  cpSync(join(root, "src/contract/release-server.d.mts"), join(staging, "bin/release-server.d.mts"));
  sources.push("src/contract/release-server.mjs", "src/contract/release-server.d.mts");
  // TanStack Intent skills: the agent guidance for this exact version. Their maintenance artifacts stay unpublished.
  copyGuidance(staging);
  sources.push("docs/sdk-changes.md", "src/contract/README.md", "LICENSE");
  sources.push(...readdirSync(join(root, "src/contract/skills"), { recursive: true, encoding: "utf8" }).filter(f => f.endsWith("/SKILL.md")).map(f => join("src/contract/skills", f)).sort());
  // JSON Schema for non-JavaScript consumers; refinements are enforced only by the zod schemas.
  mkdirSync(join(staging, "schemas"));
  const schemas: Record<string, z.ZodType> = { reportCommand: contract.reportCommand, payeeWorkOrderRequest: contract.payeeWorkOrderRequest, session: contract.session,
    invoicesView: contract.invoicesView, fileResult: contract.fileResult, workOrderList: contract.workOrderList, publicWorkOrder: contract.publicWorkOrder,
    workOrderRequestResult: contract.workOrderRequestResult, payeeCompensationView: contract.payeeCompensationView, requestRecord: contract.requestRecord,
    ownerCompensationView: contract.ownerCompensationView, compensationSend: contract.compensationSend, errorBody: contract.errorBody,
    agentConnection: contract.agentConnection, agentConnectionIssue: contract.agentConnectionIssue, agentConnectionStarted: contract.agentConnectionStarted,
    agentConnectionList: contract.agentConnectionList };
  for (const [key, schema] of Object.entries(schemas)) writeFileSync(join(staging, "schemas", `${key}.json`), JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }), null, 2) + "\n");

  const dependencies = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies as Record<string, string>;
  writeFileSync(join(staging, "package.json"), JSON.stringify({ name, version, type: "module", license: "MIT",
    description: "MultiAgency SDK, for the control plane for agentic treasuries on NEAR Intents: typed owner, app-server and payee clients, their schemas, and the shared release asset server.",
    keywords: ["tanstack-intent"], repository: { type: "git", url: "git+https://github.com/MultiAgency/platform.git" }, publishConfig: { access: "public" },
    // The bin path has no leading "./": npm 11 publish drops such a bin as invalid (pnpm pack keeps it).
    exports: { ".": { types: "./dist/contract/index.d.ts", default: "./dist/contract/index.js" },
      "./payee": { types: "./dist/contract/payee-entry.d.ts", default: "./dist/contract/payee-entry.js" },
      // The contract objects, for an app implementing a server from them: the only entry that loads @orpc/contract, so
      // the main entry runs beside a host that shares its own @orpc/contract (a Module Federation singleton).
      "./contract": { types: "./dist/contract/owner-contract.d.ts", default: "./dist/contract/owner-contract.js" },
      // The payout double for an app's own tests (Node); no other entry loads it.
      "./testing": { types: "./dist/testing/index.d.ts", default: "./dist/testing/index.js" },
      "./schemas/*": "./schemas/*", "./release-server": { types: "./bin/release-server.d.mts", default: "./bin/release-server.mjs" } }, bin: releaseServerBins,
    files: ["dist", "bin", "schemas", "skills", "!skills/_artifacts", "CHANGES.md", "README.md", "LICENSE", "THIRD-PARTY-NOTICES", "provenance.json"],
    // The oRPC client is bundled (`bundleOrpcClient`); the contract objects and AG-UI are dependencies. zod is the one
    // peer: the app's schemas and the SDK's must be one instance.
    dependencies: { "@orpc/contract": dependencies["@orpc/contract"], "@ag-ui/core": dependencies["@ag-ui/core"] },
    peerDependencies: { zod: ZOD_PEER } }, null, 2) + "\n");
  return sources;
}
