import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * What ships, declared once: the `platform` package (the headless gateway on staging and production), built by
 * `scripts/package-platform.mjs` from `Dockerfile.platform` with these deploy files. Local configs run the gateway on a
 * developer's machine (`pnpm demo`, the tests) and ship in no package. Anything else that could deploy (another
 * Dockerfile, packaging script or deploy file) fails below until it is declared here, so retiring or adding a product
 * is a code change, not only a docs edit.
 */
const SHIPPED = {
  platform: {
    script: "scripts/package-platform.mjs",
    dockerfile: "Dockerfile.platform",
    railway: [".railway/railway.ts", ".railway/tsconfig.json"],
    deploy: ["platform-entrypoint.sh", "platform-staging.json", "platform.json"],
  },
};
const LOCAL_CONFIGS = ["dashboard.json", "multiagency.json", "shared-demos.json"];

test("the declared package is everything that can deploy: no other Dockerfile, packaging script or deploy file", () => {
  const shipped = Object.values(SHIPPED);
  assert.deepEqual(readdirSync(".").filter(f => /^Dockerfile/.test(f)).sort(), shipped.map(p => p.dockerfile).sort(), "Dockerfiles");
  assert.equal(existsSync("Dockerfile"), false, "no ambiguous root Dockerfile");
  for (const path of ["railway.json", "railway.toml", "deploy/railway.gateway.json"])
    assert.equal(existsSync(path), false, `${path}: legacy Config as Code is retired`);
  assert.deepEqual(readdirSync("scripts").filter(f => /^package-/.test(f)).map(f => `scripts/${f}`).sort(), shipped.map(p => p.script).sort(), "packaging scripts");
  const deploy = [...shipped.flatMap(p => p.deploy), ...LOCAL_CONFIGS].sort();
  assert.deepEqual(readdirSync("deploy").sort(), deploy, "deploy files: shipped by a package or declared local");
});

test("each package declares its Dockerfile, IaC inputs and deploy files", () => {
  for (const [name, p] of Object.entries(SHIPPED)) {
    const script = readFileSync(p.script, "utf8"), literal = (text: string) => text.replaceAll(".", "\\.");
    assert.match(script, new RegExp(`copy\\(join\\(root, '${literal(p.dockerfile)}'\\), join\\(output, 'Dockerfile'\\)\\)`), `${name}: Dockerfile`);
    for (const input of p.railway) assert.ok(existsSync(input), `${name}: ${input}`);
    const copied = script.match(/for \(const name of \[([^\]]*)\]\) copy\(join\(root, 'deploy', name\)/)?.[1];
    assert.deepEqual([...(copied ?? "").matchAll(/'([^']+)'/g)].map(m => m[1]).sort(), [...p.deploy].sort(), `${name}: deploy files`);
  }
});

test("evaluated Railway IaC retains each gateway's volume, one executor replica and shutdown grace without managing variables", async () => {
  const { createRailwayContext, project } = await import("railway/iac");
  const { default: configure, partial } = await import("../.railway/railway.js");
  assert.equal(partial, "gateway", "apply is scoped to the existing gateway");
  for (const [environment, domain] of [["staging", "api.dev.multiagency.ai"], ["production", "api.multiagency.ai"]] as const) {
    const definition = await configure(createRailwayContext({ environment, projectName: "platform" }), project);
    assert.equal(definition.name, "platform");
    assert.equal(definition.environments, undefined, "the migration does not create or replace environments");
    assert.ok("variables" in definition);
    assert.deepEqual(definition.variables, { managed: false }, "existing and unknown variable names stay unmanaged");
    const resources = definition.resources?.flat() ?? [];
    assert.deepEqual(resources.map(resource => resource.address).sort(), ["service.gateway", "volume.gateway-volume"]);
    const gateway = resources.find(resource => resource.type === "service");
    assert.ok(gateway && gateway.type === "service");
    assert.equal(gateway.name, "gateway");
    assert.equal(gateway.source, undefined, "the existing packaged deployment source is not replaced");
    assert.equal(gateway.configFile, undefined, "legacy Config as Code is not selected");
    assert.equal(gateway.variables, undefined, "no variable values or secrets are declared");
    assert.deepEqual(gateway.build, { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" });
    // Railway reads its ON_FAILURE default back as unset; declaring it would leave drift and propose another redeploy.
    assert.equal(gateway.deploy?.restartPolicyType, undefined, "leave Railway's default unset so subsequent plans are idempotent");
    assert.deepEqual(gateway.deploy, {
      drainingSeconds: 45, restartPolicyMaxRetries: 5,
      healthcheckPath: "/health", multiRegionConfig: { "us-west2": { numReplicas: 1 } },
    });
    assert.deepEqual(gateway.networking, { customDomains: { [domain]: { port: 8080 } } });
    assert.deepEqual(gateway.volumeAttachments, { "gateway-volume": {
      volume: "volume.gateway-volume", mountPath: "/data", volumeConfig: { region: "us-west2", sizeMB: 50000 },
    } });
    const volume = resources.find(resource => resource.type === "volume");
    assert.ok(volume && volume.type === "volume");
    assert.equal(volume.name, "gateway-volume", "renaming the live volume could attach an empty replacement");
    assert.deepEqual(volume.config, { region: "us-west2", sizeMB: 50000 });
  }
  for (const environment of [undefined, "preview", "prodcution"])
    await assert.rejects(async () => configure(createRailwayContext({ environment, projectName: "platform" }), project), /environment|staging|production/i);
  await assert.rejects(async () => configure(createRailwayContext({ environment: "staging", projectName: "another-project" }), project), /project|platform/i);
});

test("every gateway configuration the deploy guides name is shipped in a package", () => {
  const guides = ["docs/operations.md", "docs/platform-staging.md", "docs/platform-production.md"].map(doc => readFileSync(doc, "utf8")).join("\n");
  const named = [...guides.matchAll(/DASHBOARD_FILE=\/app\/deploy\/([\w.-]+)/g)].map(([, file]) => file!);
  assert.ok(named.length);
  const shipped = Object.values(SHIPPED).flatMap(p => p.deploy);
  for (const file of named) assert.ok(shipped.includes(file), `${file} must be shipped by a package`);
});

// No deployment builds from the repository root (each package carries its own `.dockerignore`); this guards a local
// `docker build -f Dockerfile.platform .` from taking state, release artifacts or backups into an image.
test("a local build from the repository root excludes private release artifacts, state and backups", () => {
  const rules = readFileSync(".dockerignore", "utf8").split(/\r?\n/).map(line => line.trim());
  for (const path of [".test-artifacts", ".hosted", ".work-orders", ".agreements", ".notify", "*.tar", "*.tar.gz", "*.bak", "backups", "dashboard.json"])
    assert.ok(rules.includes(path), `.dockerignore must exclude ${path}`);
});
