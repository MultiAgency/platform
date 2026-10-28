import { mkdirSync, readdirSync, lstatSync, copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Explicit inputs only: never package repository roots, credentials, volumes, or node_modules.
const [destination, treasury, payables] = process.argv.slice(2);
if (!destination || !treasury || !payables) throw new Error('Usage: node scripts/package-shared-frontends.mjs NEW_DIRECTORY TREASURY_DIST PAYABLES_DIST');
const root = process.cwd(), output = resolve(destination);
if (existsSync(output)) throw new Error('Destination must not exist; releases are immutable snapshots.');
const builds = { proto: resolve('web/dist'), treasury: resolve(treasury), payables: resolve(payables) };
for (const path of Object.values(builds)) if (!existsSync(join(path, 'index.html'))) throw new Error(`Build first: ${path}`);
const files = {};
function copy(source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      if (name.startsWith('.') || name === 'node_modules') throw new Error(`Unexpected hidden/dependency input: ${source}/${name}`);
      copy(join(source, name), join(target, name));
    }
  } else if (stat.isFile()) {
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
    files[relative(output, target)] = createHash('sha256').update(readFileSync(target)).digest('hex');
  } else throw new Error(`Non-file input: ${source}`);
}
mkdirSync(output, { recursive: true });
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'src']) copy(join(root, name), join(output, name));
copy(builds.proto, join(output, 'web/dist'));
for (const area of ['treasury', 'payables']) copy(builds[area], join(output, 'frontends', area));
for (const name of ['dashboard-entrypoint.sh', 'shared-frontends.json', 'platform-staging.json']) copy(join(root, 'deploy', name), join(output, 'deploy', name));
chmodSync(join(output, 'deploy/dashboard-entrypoint.sh'), 0o755);
copy(join(root, 'Dockerfile.gateway'), join(output, 'Dockerfile'));
copy(join(root, 'deploy/railway.gateway.json'), join(output, 'railway.json'));
writeFileSync(join(output, '.dockerignore'), 'node_modules\n');
const revision = path => { try { return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } };
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(),
  note: 'File hashes identify the packaged bytes. Git revisions alone do not include concurrent working-tree edits.',
  revisions: { proto: revision(root), treasury: revision(builds.treasury), payables: revision(builds.payables) }, files }, null, 2) + '\n');
console.log(output);
