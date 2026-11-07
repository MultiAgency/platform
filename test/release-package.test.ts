import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revision } from "../scripts/release-package.mjs";

// A release package records the commit its files come from. A frozen snapshot lives inside the checkout's
// `.test-artifacts/`, so Git, asked from there, answers with the enclosing checkout's HEAD: whatever it holds by
// packaging time (candidate 0.5.3f froze 7397ad4 and its packages recorded 161ee1f, committed during the run).
test("a package's revision is its source's commit, never an enclosing checkout's HEAD", () => {
  const outer = mkdtempSync(join(tmpdir(), "release-revision-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", outer, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    git("init", "-q"); writeFileSync(join(outer, "file"), "x");
    git("add", "file"); git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "c");
    const head = git("rev-parse", "HEAD");
    assert.equal(revision(outer), head, "a repository's own root names its HEAD");

    const snapshot = join(outer, ".test-artifacts/stack-snapshots/run");
    mkdirSync(snapshot, { recursive: true });
    const frozen = "7397ad4f1307d64026339430004e22104132f0a2";
    writeFileSync(join(snapshot, "SNAPSHOT.json"), JSON.stringify({ runDigest: "run", sourceHead: frozen, overlayDiffSha256: null }));
    assert.equal(revision(snapshot), frozen, "a frozen snapshot names the commit it froze");

    const build = join(outer, "build");
    mkdirSync(build);
    assert.equal(revision(build), null, "a directory merely inside a checkout has no revision of its own");
    assert.equal(revision(join(tmpdir(), `no-repo-${process.pid}`)), null);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});
