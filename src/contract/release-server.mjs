#!/usr/bin/env node
// One release asset server for app frontends behind the platform gateway (P2 D5). Presentation only:
// GET/HEAD, no API, no outbound calls, no platform configuration. Environment: HOST, PORT, RELEASES_ROOT.
//   serve                     (default) serve RELEASES_ROOT/<ACTIVE>/
//   stage <built-dir>         copy a complete build to RELEASES_ROOT/<digest>/ and print the id
//   activate <id>             verify that release, then switch ACTIVE atomically
// A release is a directory whose contract.json declares { version, product, required, optional?, entries,
// fallback?, strip?, assetPrefix? }. Its id is the digest of the directory (the platform E2E runner's digest()).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = /^[a-f0-9]{64}$/;
const HASHED = /^\/static\/[a-zA-Z0-9_./-]*\.[a-f0-9]{8,}\.[a-z0-9]+$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** Same algorithm as test/e2e/run.mjs digest(): sorted relative names and bytes. */
export function digest(dir) {
  const hash = createHash('sha256');
  const scan = (path, prefix = '') => {
    for (const file of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + file.name;
      if (file.isDirectory()) scan(join(path, file.name), name + '/');
      else if (file.isFile()) hash.update(name).update('\0').update(readFileSync(join(path, file.name))).update('\0');
    }
  };
  scan(dir); return hash.digest('hex');
}

/** Real path inside the root, or null: no `..`, no symlink escape. */
function inside(root, ...parts) {
  if (parts.some(p => p.split('/').includes('..'))) return null;
  try {
    const real = realpathSync(join(root, ...parts)), base = realpathSync(root);
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch { return null; }
}

/** A complete release: valid id, parsable contract, every declared entry present. Throws otherwise. */
export function readRelease(root, id) {
  if (!ID.test(id)) throw new Error('Invalid release id');
  const dir = inside(root, id);
  if (!dir || !statSync(dir).isDirectory()) throw new Error('Release missing');
  const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8'));
  if (contract.version !== 1 || typeof contract.product !== 'string' || !contract.entries || typeof contract.entries !== 'object') throw new Error('Invalid contract');
  for (const file of [...Object.values(contract.entries), ...(contract.fallback ? [contract.fallback] : [])])
    if (typeof file !== 'string' || !inside(dir, file) || !statSync(inside(dir, file)).isFile()) throw new Error(`Release incomplete: ${file}`);
  return { id, dir, contract };
}
/** Releases that were activated, oldest first. Only these may supply retained assets; staged or partial ones never do. */
const history = root => { try { return readFileSync(join(root, 'HISTORY'), 'utf8').split('\n').filter(id => ID.test(id)); } catch { return []; } };
const activeId = root => { try { return readFileSync(join(root, 'ACTIVE'), 'utf8').trim(); } catch { return null; } };

/** Copy into a temporary directory, verify, then rename into place: an interrupted stage never appears as a release. */
/** A copy keeps the build's modes. A frozen build is read-only, and a read-only directory can be neither renamed nor
 * emptied, so the staged copy's directories are made owner-writable. File contents and the release id are unchanged. */
function ownerWritable(dir) {
  if (!existsSync(dir)) return;
  chmodSync(dir, statSync(dir).mode | 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) ownerWritable(join(dir, entry.name));
}

export function stage(root, built) {
  const id = digest(built), target = join(root, id);
  if (existsSync(target)) { if (digest(target) !== id) throw new Error('An existing release does not match its id'); readRelease(root, id); return id; }
  const temporary = join(root, `.staging-${process.pid}-${Date.now()}`);
  try {
    cpSync(built, temporary, { recursive: true });
    ownerWritable(temporary);
    if (digest(temporary) !== id) throw new Error('Staged copy does not match its build');
    renameSync(temporary, target);
  } finally { ownerWritable(temporary); rmSync(temporary, { recursive: true, force: true }); }
  try { readRelease(root, id); } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
  return id;
}

/** Verify completeness, identity and that no retained hashed file differs under the same name; then switch. */
export function activate(root, id) {
  const release = readRelease(root, id);
  if (digest(release.dir) !== id) throw new Error('Release bytes do not match its id');
  const files = dir => { const out = []; const scan = (p, prefix) => { for (const e of readdirSync(p, { withFileTypes: true })) e.isDirectory() ? scan(join(p, e.name), `${prefix}${e.name}/`) : out.push(`${prefix}${e.name}`); }; if (existsSync(dir)) scan(dir, '/static/'); return out; };
  for (const other of history(root).filter(name => name !== id))
    for (const name of files(join(root, id, 'static')).filter(n => HASHED.test(n))) {
      const theirs = join(root, other, name);
      if (existsSync(theirs) && !readFileSync(theirs).equals(readFileSync(join(root, id, name)))) throw new Error(`Conflicting retained asset ${name} in ${other}`);
    }
  const activated = [...history(root).filter(name => name !== id), id];
  writeFileSync(join(root, 'HISTORY.next'), activated.join('\n') + '\n'); renameSync(join(root, 'HISTORY.next'), join(root, 'HISTORY'));
  writeFileSync(join(root, 'ACTIVE.next'), id + '\n'); renameSync(join(root, 'ACTIVE.next'), join(root, 'ACTIVE'));
  return release;
}

export function releaseServer(root) {
  return createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cache-control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
    let release;
    try { release = readRelease(root, activeId(root) ?? ''); }
    catch { return res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"No complete active release"}'); }
    res.setHeader('x-release-id', release.id);
    const { contract } = release;
    let path = new URL(req.url, 'http://release').pathname;
    if (contract.strip) path = path.replace(new RegExp(`^(?:${contract.strip})(?=/|$)`), '') || '/';
    if (contract.assetPrefix && path.startsWith(`${contract.assetPrefix}/static/`)) path = path.slice(contract.assetPrefix.length);
    const send = (file, cache) => {
      const bytes = readFileSync(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...(cache && { 'cache-control': cache }) }).end(req.method === 'HEAD' ? undefined : bytes);
    };
    if (path === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, product: contract.product, release: release.id }));
    if (path === '/contract.json') return send(join(release.dir, 'contract.json'));
    const entry = contract.entries[path] ?? contract.entries[path.replace(/\/$/, '')];
    if (entry) return send(inside(release.dir, entry));
    if (HASHED.test(path)) {
      // Hashed names are immutable: the active release first, then retained ones for pages already open.
      for (const id of [release.id, ...history(root).filter(name => name !== release.id).reverse()]) {
        const file = inside(root, id, path.slice(1));
        if (file && statSync(file).isFile()) return send(file, 'public, max-age=31536000, immutable');
      }
      return res.writeHead(404).end('Not found');
    }
    // A declared SPA fallback answers client routes only: never an API-like, static or extension path.
    if (contract.fallback && !extname(path) && !/^\/(api|internal|static|gw|machine)(\/|$)/.test(path)) return send(inside(release.dir, contract.fallback));
    res.writeHead(404).end('Not found');
  });
}

// The real path: npm's bin link is a symlink, and import.meta.url names its target.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = process.env.RELEASES_ROOT, [command = 'serve', argument] = process.argv.slice(2);
  if (!root) throw new Error('RELEASES_ROOT is required');
  if (command === 'stage') console.log(stage(root, resolve(argument)));
  else if (command === 'activate') console.log(`Active release ${activate(root, argument).id}`);
  else {
    const host = process.env.HOST || '127.0.0.1', server = releaseServer(root);
    server.listen(Number(process.env.PORT || 0), host, () => console.log(`Release asset server ready on http://${host}:${server.address().port}`));
  }
}
