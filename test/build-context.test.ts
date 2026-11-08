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
    railway: "deploy/railway.gateway.json",
    deploy: ["platform-entrypoint.sh", "platform-staging.json", "platform.json"],
  },
};
const LOCAL_CONFIGS = ["dashboard.json", "multiagency.json", "shared-demos.json"];

test("the declared package is everything that can deploy: no other Dockerfile, packaging script or deploy file", () => {
  const shipped = Object.values(SHIPPED);
  assert.deepEqual(readdirSync(".").filter(f => /^Dockerfile/.test(f)).sort(), shipped.map(p => p.dockerfile).sort(), "Dockerfiles");
  assert.equal(existsSync("Dockerfile"), false, "no ambiguous root Dockerfile");
  assert.equal(existsSync("railway.json"), false, "no root Railway config: each package carries its own");
  assert.deepEqual(readdirSync("scripts").filter(f => /^package-/.test(f)).map(f => `scripts/${f}`).sort(), shipped.map(p => p.script).sort(), "packaging scripts");
  const deploy = [...shipped.flatMap(p => [...p.deploy, p.railway.replace("deploy/", "")]), ...LOCAL_CONFIGS].sort();
  assert.deepEqual(readdirSync("deploy").sort(), deploy, "deploy files: shipped by a package or declared local");
});

test("each package carries exactly its declared Dockerfile, Railway config and deploy files", () => {
  for (const [name, p] of Object.entries(SHIPPED)) {
    const script = readFileSync(p.script, "utf8"), literal = (text: string) => text.replaceAll(".", "\\.");
    assert.match(script, new RegExp(`copy\\(join\\(root, '${literal(p.dockerfile)}'\\), join\\(output, 'Dockerfile'\\)\\)`), `${name}: Dockerfile`);
    assert.match(script, new RegExp(`copy\\(join\\(root, '${literal(p.railway)}'\\), join\\(output, 'railway\\.json'\\)\\)`), `${name}: railway.json`);
    const copied = script.match(/for \(const name of \[([^\]]*)\]\) copy\(join\(root, 'deploy', name\)/)?.[1];
    assert.deepEqual([...(copied ?? "").matchAll(/'([^']+)'/g)].map(m => m[1]).sort(), [...p.deploy].sort(), `${name}: deploy files`);
    const railway = JSON.parse(readFileSync(p.railway, "utf8"));
    assert.equal(railway.build.dockerfilePath, "Dockerfile", `${name}: the package's Dockerfile`);
    // Railway's default is SIGKILL at once; the gateway needs 30 s for its children, then up to 5 s more (architecture.md).
    assert.ok(railway.deploy.drainingSeconds > 35, `${name}: deploy grace exceeds the gateway's shutdown bound`);
  }
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
