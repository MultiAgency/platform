// Checks the `platform` image: builds it from a package exactly as Railway does (the package's own Dockerfile), then
// runs scripts/platform-image-inside.ts in it with --network none, no volume and no credentials.
//
//   node scripts/check-platform-image.mjs [<package directory>]
//
// With a directory (a release candidate's `.test-artifacts/releases/<digest>/platform`), that package is checked: the
// bytes that deploy. Without one, the package is made from this tree's web build (run `pnpm build:web` first). Needs
// Docker; the build downloads the base image and dependencies, the check itself has no network.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
let made;
let pkg = process.argv[2] && resolve(process.argv[2]);
const imageOutput = process.argv[3] && resolve(process.argv[3]);
if (!pkg) {
  if (!existsSync(join(root, 'web/dist/build-manifest.json'))) throw new Error('Run `pnpm build:web` first, or pass a package directory');
  made = mkdtempSync(join(tmpdir(), 'platform-image-')); pkg = join(made, 'platform');
  execFileSync(process.execPath, ['scripts/package-platform.mjs', pkg], { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(pkg, 'Dockerfile')) || !existsSync(join(pkg, 'manifest.json'))) throw new Error(`${pkg} is not a platform package`);
const tag = `multiagency-platform-check:${process.pid}`;
try {
  execFileSync('docker', ['build', '--tag', tag, pkg], { stdio: 'inherit' });
  const run = spawnSync('docker', ['run', '--rm', '--network', 'none',
    '--volume', `${join(root, 'scripts/platform-image-inside.ts')}:/app/platform-image-inside.ts:ro`,
    tag, '/app/node_modules/.bin/tsx', '/app/platform-image-inside.ts'], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
  if (run.status === 0 && imageOutput) {
    const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).trim();
    const platform = execFileSync('docker', ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', tag], { encoding: 'utf8' }).trim();
    execFileSync('docker', ['image', 'save', '--output', imageOutput, tag], { stdio: 'inherit' });
    writeFileSync(`${imageOutput}.json`, JSON.stringify({ imageId, platform, tag, archive: imageOutput,
      archiveSha256: createHash('sha256').update(readFileSync(imageOutput)).digest('hex'),
      scope: 'Local image checked offline; no registry publication or deployed-host claim' }, null, 2) + '\n');
    console.log(`IMAGE: ${imageId}`);
  }
} finally {
  spawnSync('docker', ['image', 'rm', '--force', tag], { stdio: 'ignore' });
  if (made) rmSync(made, { recursive: true, force: true });
}
