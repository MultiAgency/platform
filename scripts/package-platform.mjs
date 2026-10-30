import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releasePackage, revision } from './release-package.mjs';

// The `platform` package: the headless engine for apps (`/apps/v1`, the confirm page), with no owner app, demo hosts
// or app frontends. Its web build is the confirm entry's files alone, taken from the tested `web/dist` by rsbuild's
// build manifest, so the page shipped is the page the candidate's suites exercised.
const [destination] = process.argv.slice(2);
if (!destination) throw new Error('Usage: node scripts/package-platform.mjs NEW_DIRECTORY');
const root = process.cwd(), dist = join(root, 'web/dist');
const confirm = JSON.parse(readFileSync(join(dist, 'build-manifest.json'), 'utf8')).entries?.confirm;
if (!confirm?.html?.includes('/confirm.html')) throw new Error('Build first: web/dist has no confirm entry in build-manifest.json');
const assets = [...confirm.html, ...confirm.initial?.js ?? [], ...confirm.initial?.css ?? [], ...confirm.async?.js ?? [], ...confirm.async?.css ?? [], ...confirm.assets ?? []];
const { output, copy, finish } = releasePackage(destination);
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'src']) copy(join(root, name), join(output, name));
for (const asset of assets) {
  copy(join(dist, asset), join(output, 'web/dist', asset));
  // A bundled library's license travels with it.
  if (existsSync(join(dist, `${asset}.LICENSE.txt`))) copy(join(dist, `${asset}.LICENSE.txt`), join(output, 'web/dist', `${asset}.LICENSE.txt`));
}
for (const name of ['platform-entrypoint.sh', 'platform-staging.json', 'platform.json']) copy(join(root, 'deploy', name), join(output, 'deploy', name));
chmodSync(join(output, 'deploy/platform-entrypoint.sh'), 0o755);
copy(join(root, 'Dockerfile.platform'), join(output, 'Dockerfile'));
copy(join(root, 'deploy/railway.gateway.json'), join(output, 'railway.json'));
finish({ platform: revision(root) });
