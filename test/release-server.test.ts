import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { activate, releaseServer, stage } from "../src/contract/release-server.mjs";

const scratch = mkdtempSync(join(tmpdir(), "release-server-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
/** A built frontend directory: files by relative path. */
function build(files: Record<string, string>) {
  const dir = join(scratch, `build-${++n}`);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); }
  return dir;
}
const contract = (extra: object) => JSON.stringify({ version: 1, required: ["gateway-session-v1"], ...extra });
async function serve(root: string) {
  const server = releaseServer(root);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>(r => server.close(() => r())) };
}
const freshRoot = () => { const root = join(scratch, `root-${++n}`); mkdirSync(root); return root; };

test("Invoices-shaped release: declared entries and scoped paths only; everything else 404; writes 405", async () => {
  const root = freshRoot();
  const id = stage(root, build({ "contract.json": contract({ product: "invoices", entries: { "/": "index.html", "/submit": "index.html", "/report": "contributor.html", "/invoice-browser.js": "invoice-browser.js" },
    strip: "/i/own-[a-f0-9]{24}", assetPrefix: "/invoice-ui" }), "index.html": "<title>Invoices</title>", "contributor.html": "<title>Report</title>",
    "invoice-browser.js": "export {}", "static/js/contributor.0123abcd.js": "chunk" }));
  activate(root, id);
  const { origin, close } = await serve(root);
  try {
    const scoped = `/i/own-${"a".repeat(24)}`;
    for (const path of ["/", "/submit", "/submit/", "/report", "/report/", `${scoped}/`, `${scoped}/report`, "/invoice-ui/static/js/contributor.0123abcd.js", "/invoice-browser.js", "/contract.json"]) {
      const answer = await fetch(origin + path);
      assert.equal(answer.status, 200, path);
      assert.equal(answer.headers.get("x-release-id"), id);
      assert.equal(answer.headers.get("x-frame-options"), "DENY"); assert.equal(answer.headers.get("referrer-policy"), "no-referrer"); assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    }
    assert.equal((await fetch(origin + "/")).headers.get("cache-control"), "no-store");
    assert.match((await fetch(origin + "/invoice-ui/static/js/contributor.0123abcd.js")).headers.get("cache-control")!, /immutable/);
    for (const path of ["/api/invoices", "/internal/agreements", "/.env", "/i/unknown/", "/server.mjs", "/release-server.mjs", "/plans"])
      assert.equal((await fetch(origin + path)).status, 404, path);
    assert.equal((await fetch(origin + "/", { method: "POST" })).status, 405);
    assert.deepEqual(await (await fetch(origin + "/health")).json(), { ok: true, product: "invoices", release: id });
  } finally { await close(); }
});

test("a declared SPA fallback answers client routes only, never API, static or extension paths", async () => {
  const root = freshRoot();
  activate(root, stage(root, build({ "contract.json": contract({ product: "treasury", entries: { "/": "index.html" }, fallback: "index.html" }), "index.html": "<title>T</title>" })));
  const { origin, close } = await serve(root);
  try {
    for (const path of ["/plans", "/a/portfolio/activity"]) assert.equal(await (await fetch(origin + path)).text(), "<title>T</title>", path);
    for (const path of ["/api/x", "/internal/x", "/gw/me", "/static/js/missing.0123abcd.js", "/static/unhashed", "/robots.txt", "/a/portfolio/rpc.json"])
      assert.equal((await fetch(origin + path)).status, 404, path);
  } finally { await close(); }
});

test("activation keeps retained hashed assets for open pages, switches HTML at once, and rolls back", async () => {
  const root = freshRoot();
  const files = (title: string, chunk: string) => ({ "contract.json": contract({ product: "payables", entries: { "/": "index.html" } }), "index.html": `<title>${title}</title>`, [`static/js/${chunk}.js`]: chunk });
  const a = stage(root, build(files("A", "main.aaaaaaaa"))), b = stage(root, build(files("B", "main.bbbbbbbb")));
  activate(root, a);
  const { origin, close } = await serve(root);
  try {
    assert.equal(await (await fetch(origin + "/")).text(), "<title>A</title>");
    activate(root, b);
    const page = await fetch(origin + "/");
    assert.equal(await page.text(), "<title>B</title>"); assert.equal(page.headers.get("x-release-id"), b);
    assert.equal(await (await fetch(origin + "/static/js/main.aaaaaaaa.js")).text(), "main.aaaaaaaa", "an open release-A page still loads its chunk");
    activate(root, a);
    assert.equal(await (await fetch(origin + "/")).text(), "<title>A</title>", "rollback");
  } finally { await close(); }
});

test("activation refuses incomplete, altered, conflicting or escaping releases; a bad pointer serves nothing", async () => {
  const root = freshRoot(), entries = { "/": "index.html" };
  assert.throws(() => stage(root, build({ "contract.json": contract({ product: "p", entries }), "other.html": "x" })), /incomplete/);
  const a = stage(root, build({ "contract.json": contract({ product: "p", entries }), "index.html": "A", "static/js/main.aaaaaaaa.js": "one" }));
  activate(root, a);
  // Staging only copies and verifies a build; activation refuses a same-name hashed asset with different bytes.
  const c = stage(root, build({ "contract.json": contract({ product: "p", entries }), "index.html": "C", "static/js/main.aaaaaaaa.js": "two" }));
  assert.throws(() => activate(root, c), /Conflicting retained asset/);
  const d = stage(root, build({ "contract.json": contract({ product: "p", entries }), "index.html": "D" }));
  writeFileSync(join(root, d, "index.html"), "tampered");
  assert.throws(() => activate(root, d), /do not match/);
  const outside = join(scratch, "outside.html"); writeFileSync(outside, "secret");
  const escaping = build({ "contract.json": contract({ product: "p", entries }) }); symlinkSync(outside, join(escaping, "index.html"));
  assert.throws(() => stage(root, escaping), /incomplete/);
  assert.equal(readFileSync(join(root, "ACTIVE"), "utf8").trim(), a, "every refusal left the active release unchanged");
  writeFileSync(join(root, "ACTIVE"), "../outside\n");
  const { origin, close } = await serve(root);
  try { assert.equal((await fetch(origin + "/")).status, 503); } finally { await close(); }
});

// Run directly, and through a symlink as npm links the `proto-release-server` bin.
for (const via of ["path", "bin link"]) test(`the release server runs as its own process with only HOST, PORT and RELEASES_ROOT (${via})`, async () => {
  const root = freshRoot();
  activate(root, stage(root, build({ "contract.json": contract({ product: "p", entries: { "/": "index.html" } }), "index.html": "ok" })));
  let entry = fileURLToPath(new URL("../src/contract/release-server.mjs", import.meta.url));
  if (via === "bin link") { const link = join(scratch, `bin-${n++}`); symlinkSync(entry, link); entry = link; }
  const child = spawn(process.execPath, [entry],
    { cwd: tmpdir(), env: { HOST: "127.0.0.1", PORT: "0", RELEASES_ROOT: root }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const origin = await new Promise<string>((resolve, reject) => { let out = ""; child.stdout.on("data", c => { out += c; const m = out.match(/ready on (http:\S+)/); if (m) resolve(m[1]!); }); child.once("exit", code => reject(new Error(`exited ${code}`))); });
    assert.equal(await (await fetch(origin + "/")).text(), "ok");
    assert.equal((await (await fetch(origin + "/health")).json() as { product: string }).product, "p");
  } finally { child.kill(); }
});

test("only activated releases supply retained assets: a never-activated or partial directory serves nothing", async () => {
  const root = freshRoot();
  activate(root, stage(root, build({ "contract.json": contract({ product: "p", entries: { "/": "index.html" } }), "index.html": "A" })));
  const orphan = join(root, "f".repeat(64), "static/js"); mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "orphan.0123456789.js"), "truncated");
  const staged = stage(root, build({ "contract.json": contract({ product: "p", entries: { "/": "index.html" } }), "index.html": "B", "static/js/next.abcdef0123.js": "next" }));
  const { origin, close } = await serve(root);
  try {
    assert.equal((await fetch(origin + "/static/js/orphan.0123456789.js")).status, 404, "never activated");
    assert.equal((await fetch(origin + "/static/js/next.abcdef0123.js")).status, 404, "staged but not activated");
    activate(root, staged);
    assert.equal(await (await fetch(origin + "/static/js/next.abcdef0123.js")).text(), "next");
  } finally { await close(); }
  assert.ok(!readdirSync(root).some(name => name.startsWith(".staging-")), "no staging leftovers");
});

/** Set every directory and file under `dir` to `mode` (directories) and `mode & 0o666` (files). */
function chmodTree(dir: string, mode: number) {
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    entry.isDirectory() ? chmodTree(join(dir, entry.name), mode) : chmodSync(join(dir, entry.name), mode & 0o666);
  chmodSync(dir, mode);
}

test("a frozen read-only build stages, activates and serves; the staged release is writable by its owner", async () => {
  const built = build({ "contract.json": contract({ product: "treasury", entries: { "/": "index.html" } }), "index.html": "<!doctype html><title>Frozen</title>", "static/js/app.0123456789.js": "x" });
  chmodTree(built, 0o555); // frozen apps hand over read-only directories (dr-xr-xr-x), as Invoices and Treasury do
  const root = freshRoot();
  try {
    const id = stage(root, built);
    activate(root, id);
    assert.equal(statSync(join(root, id)).mode & 0o200, 0o200, "the staged copy can be renamed and removed");
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith(".staging-")), [], "no staging leftovers");
    const { origin, close } = await serve(root);
    try { assert.equal(await (await fetch(`${origin}/`)).text(), "<!doctype html><title>Frozen</title>"); } finally { await close(); }
  } finally { chmodTree(built, 0o755); }
});
