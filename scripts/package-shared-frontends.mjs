import { chmodSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { releasePackage, revision } from './release-package.mjs';

// The `dao` package: the prototype's full deployment, with the Treasury and Payables frontends.
const [destination, treasury, payables] = process.argv.slice(2);
if (!destination || !treasury || !payables) throw new Error('Usage: node scripts/package-shared-frontends.mjs NEW_DIRECTORY TREASURY_DIST PAYABLES_DIST');
const root = process.cwd();
const builds = { proto: resolve('web/dist'), treasury: resolve(treasury), payables: resolve(payables) };
for (const path of Object.values(builds)) if (!existsSync(join(path, 'index.html'))) throw new Error(`Build first: ${path}`);
const { output, copy, finish } = releasePackage(destination);
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'src']) copy(join(root, name), join(output, name));
copy(builds.proto, join(output, 'web/dist'));
for (const area of ['treasury', 'payables']) copy(builds[area], join(output, 'frontends', area));
for (const name of ['dashboard-entrypoint.sh', 'shared-frontends.json']) copy(join(root, 'deploy', name), join(output, 'deploy', name));
chmodSync(join(output, 'deploy/dashboard-entrypoint.sh'), 0o755);
copy(join(root, 'Dockerfile.gateway'), join(output, 'Dockerfile'));
copy(join(root, 'deploy/railway.gateway.json'), join(output, 'railway.json'));
finish({ proto: revision(root), treasury: revision(builds.treasury), payables: revision(builds.payables) });
