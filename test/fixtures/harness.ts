import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, mock } from "node:test";
import { fileURLToPath } from "node:url";

/** Offline setup shared by the suites. Real SQLite, files and child processes; never the network. */

/** For suites that run a fixture in a child process, as a separate server or CLI would be. */
export const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

/** Own scratch state without changing cwd; register cleanup after the suite's process teardown. */
export function temporaryDirectories() {
  const directories: string[] = [];
  return {
    create(prefix: string) {
      const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
      directories.push(directory);
      return directory;
    },
    cleanup() {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
      directories.length = 0;
    },
  };
}

/**
 * Runs the suite's tests in a fresh temporary directory, a new instance's state: one per test by
 * default, or one for the whole suite. Call it before the suite's own hooks, which then run inside it.
 */
export function freshDirectory(prefix: string, { per = "test" }: { per?: "test" | "suite" } = {}) {
  const home = process.cwd();
  const directories = temporaryDirectories();
  (per === "test" ? beforeEach : before)(() => {
    process.chdir(directories.create(prefix));
  });
  after(() => {
    process.chdir(home);
    directories.cleanup();
  });
}

/** Any network call fails, so a test that would reach the provider or a chain says so. */
export const offline = () => mock.method(globalThis, "fetch", async () => { throw new Error("offline only"); });

/** The app access log's text, every month's file in order (`accessLog`); empty when nothing was logged. */
export const accessLogText = (root = ".app-access") => {
  const files = existsSync(root) ? readdirSync(root).filter(name => /^access-\d{4}-\d{2}\.jsonl$/.test(name)).sort() : [];
  return files.map(name => readFileSync(join(root, name), "utf8")).join("");
};
