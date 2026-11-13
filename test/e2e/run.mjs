import { cpSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runChallenges } from './challenge.mjs';
import { dependencyTree } from '../../scripts/dependency-tree.mjs';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';

const root = resolve(import.meta.dirname, '../..');
const parent = join(root, '.test-artifacts/e2e'); mkdirSync(parent, { recursive: true });
const artifacts = mkdtempSync(join(parent, 'run-')), snapshot = join(artifacts, 'snapshot'); mkdirSync(snapshot);
// `--prebuilt-web`: test the frontend already built in this tree (a frozen candidate's web/dist) instead of rebuilding
// it, so the build that ships is the build these cases tested. A rebuild isn't byte-reproducible.
const prebuilt = process.argv.includes('--prebuilt-web'), builtWeb = join(root, 'web/dist');
if (prebuilt && !existsSync(join(builtWeb, 'confirm.html'))) throw new Error('--prebuilt-web needs a built web/dist in this tree');
for (const name of ['src', 'web', 'evidence', 'scripts', 'examples', 'test/e2e', 'test/offline.env', 'test/fixtures/offline-network.cjs', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']) {
  const target = join(snapshot, name); mkdirSync(resolve(target, '..'), { recursive: true });
  cpSync(join(root, name), target, { recursive: true, filter: path => !path.endsWith('/node_modules') && (!path.endsWith('/dist') || (prebuilt && path === builtWeb)) });
}
symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
// Explicit consumer input: snapshot the actual Treasury skill, never maintain a second copy here.
const args = process.argv.slice(2).filter(arg => arg !== '--prebuilt-web');
const consumerIndex = args.indexOf('--treasury-skill');
let consumer, consumerDigest = null, consumerDependencies = null;
if (consumerIndex !== -1) {
  const input = args[consumerIndex + 1];
  if (!input || input.startsWith('--')) throw new Error('--treasury-skill requires a directory');
  // The skill's own files, copied into the snapshot.
  consumer = join(snapshot, '.consumer-fixtures/treasury-skill');
  mkdirSync(consumer, { recursive: true });
  for (const name of ['SKILL.md', 'references/api.md', 'scripts/treasury.mjs', 'scripts/package.json']) {
    mkdirSync(resolve(join(consumer, name), '..'), { recursive: true });
    cpSync(join(resolve(input), name), join(consumer, name));
  }
  // The helper runs on its own pinned dependencies, as an external agent installs them, not on Proto's: a helper on an
  // older oRPC client is then tested against this server. The install happens here, before the offline test run.
  const required = JSON.parse(readFileSync(join(consumer, 'scripts/package.json'))).dependencies['@orpc/client'];
  consumerDigest = digest(consumer); // the skill's own files, before its dependencies are installed beside them
  const installing = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline'], { cwd: join(consumer, 'scripts'), encoding: 'utf8' });
  if (installing.status !== 0) throw new Error(`Treasury helper dependencies did not install:\n${installing.stdout}${installing.stderr}`);
  const installed = JSON.parse(readFileSync(join(consumer, 'scripts/node_modules/@orpc/client/package.json'))).version;
  if (required !== installed) throw new Error(`Treasury helper requires @orpc/client ${required}, installed ${installed}`);
  consumerDependencies = { orpcClient: installed, lockSha256: createHash('sha256').update(readFileSync(join(consumer, 'scripts/package-lock.json'))).digest('hex') };
  args.splice(consumerIndex, 2);
}

const env = { ...offlineEnvironment(), NODE_ENV: 'production', PROTO_E2E_ISOLATED: '1', PROTO_E2E_ARTIFACTS: artifacts,
  NODE_OPTIONS: `--require ${JSON.stringify(join(snapshot, 'test/fixtures/offline-network.cjs'))}` };
if (consumer) env.PROTO_E2E_TREASURY_SKILL = consumer;
for (const key of ['BROWSER_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[key]) env[key] = process.env[key];
function digest(dir) {
  const hash = createHash('sha256');
  function scan(path, prefix = '') {
    for (const file of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + file.name;
      if (file.isDirectory()) scan(join(path, file.name), name + '/');
      else if (file.isFile()) hash.update(name).update('\0').update(readFileSync(join(path, file.name))).update('\0');
    }
  }
  scan(dir); return hash.digest('hex');
}
const run = (command, args) => spawnSync(command, args, { cwd: snapshot, env, stdio: 'inherit' });
console.log(`Isolated E2E release and evidence: ${artifacts}`);
if (!prebuilt) {
  const build = run(join(root, 'node_modules/.bin/rsbuild'), ['build', '--root', 'web']);
  if (build.status !== 0) process.exit(build.status ?? 1);
}
// The installed dependency tree this run uses (node_modules is shared, not copied). A frozen snapshot that recorded one
// must run against the same tree, and the tree must not change during the run.
const dependencies = dependencyTree(root);
const frozen = existsSync(join(root, 'SNAPSHOT.json')) ? JSON.parse(readFileSync(join(root, 'SNAPSHOT.json'), 'utf8')).dependencyTree : undefined;
if (frozen && frozen !== dependencies) throw new Error(`The installed dependency tree (${dependencies}) differs from the one this snapshot was frozen with (${frozen}); reinstall that tree or freeze again.`);
writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({ node: process.version, dependencyTree: dependencies, treasurySkill: consumerDigest, treasurySkillDependencies: consumerDependencies, source: digest(join(snapshot, 'src')),
  frontend: digest(join(snapshot, 'web/src')), evidence: digest(join(snapshot, 'evidence')), assets: digest(join(snapshot, 'web/dist')), tests: digest(join(snapshot, 'test/e2e')),
  playwright: JSON.parse(readFileSync(join(root, 'node_modules/@playwright/test/package.json'))).version,
  lockfile: createHash('sha256').update(readFileSync(join(snapshot, 'pnpm-lock.yaml'))).digest('hex'), scope: 'offline application E2E; simulated provider, chain, and wallet' }, null, 2));
// `--narrow`: a deliberately partial run (some cases skipped for missing inputs) that is not evidence of the whole suite.
const narrowAt = args.indexOf('--narrow'), narrow = narrowAt !== -1;
if (narrow) args.splice(narrowAt, 1);
const exploring = args[0] === '--explore', serving = args[0] === '--stack';
const challenging = args[0] === '--challenge';
if (challenging && args.length !== 1) throw new Error('Challenge runs require the complete baseline; no filters allowed.');
if (challenging) {
  const listed = spawnSync(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c',
    'test/e2e/playwright.config.mjs', '--list', '--reporter=json'], { cwd: snapshot, env, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`Cannot discover the challenge baseline: ${listed.stderr}`);
  // Discovery comes from the same isolated source/configuration, before executing any cases.
  writeFileSync(join(artifacts, 'baseline-list.json'), listed.stdout);
}
const result = run(process.execPath, serving ? ['test/e2e/stack.mjs', ...args.slice(1)] : exploring ? ['test/e2e/explore.mjs', ...args.slice(1)] : [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'test/e2e/playwright.config.mjs', ...(challenging ? [] : args)]);
process.exitCode = result.status ?? 1;
if (dependencyTree(root) !== dependencies) { console.error('The installed dependency tree changed during the run; its results do not identify one tree.'); process.exitCode = 1; }
// A plain run is the whole suite: a skipped case (the Treasury skill not given) fails it unless --narrow.
if (!serving && !exploring && result.status === 0 && existsSync(join(artifacts, 'results.json'))) {
  const skipped = [];
  const visit = suite => { for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) if (t.status === 'skipped') skipped.push(`${spec.file}: ${spec.title}`); for (const child of suite.suites ?? []) visit(child); };
  for (const suite of JSON.parse(readFileSync(join(artifacts, 'results.json'), 'utf8')).suites ?? []) visit(suite);
  if (skipped.length && !narrow) {
    console.error(`${skipped.length} case(s) skipped; a plain run must execute every case (pass --narrow for a deliberately partial run):\n${skipped.map(s => `  ${s}`).join('\n')}`);
    process.exitCode = 1;
  } else if (skipped.length) console.error(`Narrow run: ${skipped.length} case(s) skipped by design.`);
}
if (challenging && result.status === 0) process.exitCode = runChallenges({ snapshot, artifacts, env, root }) ? 0 : 1;
