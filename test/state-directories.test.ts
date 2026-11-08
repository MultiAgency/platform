import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// One list of state directories to preserve: docs/operations.md is canonical; its copies and the source agree with it.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dirs = (text: string) => new Set([...text.matchAll(/`(\.[a-z][a-z-]+)\/`/g)].map(m => m[1]!));
const canonical = dirs(read("docs/operations.md").match(/<!-- state-directories -->([\s\S]*?)<!-- \/state-directories -->/)![1]!.replace("`.intake/`", ""));
const sorted = (set: Set<string>) => [...set].sort();

test("the canonical list names every state directory the source writes", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(f => /\.(ts|js)$/.test(f));
  const written = new Set<string>();
  // A dot-directory literal followed by a path separator or the end of the literal: `".ops"`, `".invoices/x"`, `` `.hosted/` ``.
  for (const file of files) for (const m of readFileSync(join(src, file), "utf8").matchAll(/["'`](\.[a-z][a-z-]+)(?=[/"'`])/g)) written.add(m[1]!);
  // File extensions, settings files and the legacy intake are not preserved directories.
  for (const other of [".json", ".js", ".ts", ".html", ".css", ".svg", ".md", ".env", ".intake", ".jsonl", ".sqlite", ".mjs", ".png", ".txt"]) written.delete(other);
  assert.deepEqual(sorted(written).filter(d => !canonical.has(d)), [], "written by src but missing from docs/operations.md");
});

test("AGENTS.md repeats the canonical list exactly", () => {
  const agents = read("AGENTS.md").match(/preserves every state directory[\s\S]*?\n {2}\(canonical list[^\n]*\n?[^\n]*/)![0];
  assert.deepEqual(sorted(dirs(agents)), sorted(canonical));
});
