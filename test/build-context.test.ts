import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("the invoices Docker context explicitly excludes private release artifacts, state and backups", () => {
  for (const file of [".dockerignore"]) {
    const rules = readFileSync(file, "utf8").split(/\r?\n/).map(line => line.trim());
    for (const path of [".test-artifacts", ".hosted", ".work-orders", ".agreements", ".notify", "*.tar", "*.tar.gz", "*.bak", "backups", "dashboard.json"])
      assert.ok(rules.includes(path), `${file} must exclude ${path}`);
  }
});

test("every Dockerfile names what it runs: no root default, and each config selects an existing image", () => {
  assert.equal(existsSync("Dockerfile"), false, "no ambiguous root Dockerfile");
  assert.equal(JSON.parse(readFileSync("railway.json", "utf8")).build.dockerfilePath, "Dockerfile.payouts");
  assert.ok(existsSync("Dockerfile.payouts"));
  // The executor image has no paired ignore file, so BuildKit uses `.dockerignore` (checked above).
  assert.equal(existsSync("Dockerfile.payouts.dockerignore"), false);
  // The gateway is built only from the package, where it becomes the package's root Dockerfile.
  const pack = readFileSync("scripts/package-shared-frontends.mjs", "utf8");
  assert.match(pack, /copy\(join\(root, 'Dockerfile\.gateway'\), join\(output, 'Dockerfile'\)\)/);
  assert.match(pack, /copy\(join\(root, 'deploy\/railway\.gateway\.json'\), join\(output, 'railway\.json'\)\)/);
  assert.equal(JSON.parse(readFileSync("deploy/railway.gateway.json", "utf8")).build.dockerfilePath, "Dockerfile");
});

test("every gateway configuration the operations guide deploys is in a package (the prototype's or the platform's)", () => {
  const packaged = ["scripts/package-shared-frontends.mjs", "scripts/package-platform.mjs"].map(script =>
    readFileSync(script, "utf8").match(/for \(const name of \[([^\]]*)\]\) copy\(join\(root, 'deploy', name\)/)?.[1]).join(",");
  assert.ok(packaged.includes("'"), "the packages copy named deploy files");
  const named = [...readFileSync("docs/operations.md", "utf8").matchAll(/DASHBOARD_FILE=\/app\/deploy\/([\w.-]+)/g)].map(([, file]) => file);
  assert.ok(named.length);
  for (const file of named) {
    assert.ok(existsSync(`deploy/${file}`), file);
    assert.ok(packaged.includes(`'${file}'`), `${file} must be packaged`);
  }
});
