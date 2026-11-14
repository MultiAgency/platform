import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runAppJourney } from './app-driver.mjs';

assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Cross-repository release evidence requires Node 24 or later');
const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must identify the exact offline test input`);
  return value;
};
const root = required('CROSSREPO_ROOT');
const platformRoot = required('CROSSREPO_PLATFORM_ROOT');
const sdkGit = required('CROSSREPO_SDK_GIT');
const platformMerge = required('CROSSREPO_PLATFORM_COMMIT');
const fixtureOverrides = new Set(['test/e2e/provider.mjs', 'test/e2e/stack-controls.mjs']);
const tree = execFileSync('git', ['-C', sdkGit, 'rev-parse', `${platformMerge}^{tree}`], { encoding: 'utf8' }).trim();
const rows = execFileSync('git', ['-C', sdkGit, 'ls-tree', '-rz', platformMerge]).toString('utf8').split('\0').filter(Boolean);
let identicalFiles = 0;
for (const row of rows) {
  const tab = row.indexOf('\t'), [mode, type, objectId] = row.slice(0, tab).split(' '), name = row.slice(tab + 1);
  if (type !== 'blob') throw new Error(`Unexpected source object ${name}: ${type}`);
  const content = mode === '120000' ? Buffer.from(readlinkSync(join(platformRoot, name))) : readFileSync(join(platformRoot, name));
  const actual = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  if (fixtureOverrides.has(name)) continue;
  assert.equal(actual, objectId, `Copied platform source diverged from merged main: ${name}`);
  identicalFiles++;
}
assert.equal(rows.length - identicalFiles, fixtureOverrides.size, 'Only the declared provider/controls overlays may differ');
const harnessDirectory = fileURLToPath(new URL('.', import.meta.url));
const archivedHarnessDirectory = join(platformRoot, 'test/cross-repo/treasury-orders');
const harnessFiles = ['run.sh', 'runner.mjs', 'app-driver.mjs', 'fixtures.patch', 'README.md'];
const archivedFilesPresent = harnessFiles.map(file => existsSync(join(archivedHarnessDirectory, file)));
const archivedHarnessMatched = archivedFilesPresent.every(Boolean);
if (archivedHarnessMatched) {
  for (const file of harnessFiles) assert(readFileSync(join(harnessDirectory, file)).equals(readFileSync(join(archivedHarnessDirectory, file))),
    `Executed cross-repo harness differs from signed platform commit: ${file}`);
} else {
  assert(archivedFilesPresent.every(present => !present) && process.env.CROSSREPO_ALLOW_PRECOMMIT === '1',
    'The signed platform commit must contain the exact executed cross-repo harness');
}
const { dependencyTree } = await import(pathToFileURL(join(platformRoot, 'scripts/dependency-tree.mjs')).href);
const installedDependencyTree = dependencyTree(platformRoot);
const dependencySnapshot = required('CROSSREPO_DEPENDENCY_SNAPSHOT');
assert.equal(installedDependencyTree, JSON.parse(readFileSync(join(dependencySnapshot, 'SNAPSHOT.json'), 'utf8')).dependencyTree,
  'Installed platform dependencies differ from the frozen candidate snapshot');
const stackDirectory = required('CROSSREPO_STACK_DIRECTORY');
const state = JSON.parse(readFileSync(join(stackDirectory, 'state.json'), 'utf8'));
const loopback = input => {
  const host = new URL(input).hostname;
  assert(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host), `Non-loopback stack endpoint: ${host}`);
};
for (const endpoint of [state.dashboard, state.chain.rpc, state.app.base, state.treasury.machineBase]) loopback(endpoint);
assert(state.dashboard.startsWith('https://127.0.0.1:'));
assert.equal(state.app.deployment, 'treasury-app');
assert.equal(state.treasury.agent, 'portfolio');
let sequence = 0;
const control = async (command, input = {}) => {
  const name = `cross-${process.pid}-${++sequence}-${randomBytes(3).toString('hex')}`;
  const path = join(stackDirectory, 'controls', `${name}.json`);
  const answer = path.replace(/\.json$/, '.result.json');
  writeFileSync(`${path}.tmp`, JSON.stringify({ command, ...input }));
  renameSync(`${path}.tmp`, path);
  for (let tries = 0; tries < 300; tries++) {
    if (existsSync(answer)) return JSON.parse(readFileSync(answer, 'utf8'));
    await delay(100);
  }
  throw new Error(`Offline stack control ${command} timed out`);
};
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = {
  scope: 'offline cross-repository order acceptance; simulated provider, chain, owner key and funds',
  platformMerge,
  platformTree: tree,
  identicalSourceFiles: identicalFiles,
  archivedHarnessMatched,
  installedDependencyTree,
  testOnlyFixtureOverrides: [...fixtureOverrides],
  treasuryAppCommit: required('CROSSREPO_APP_HEAD'),
  sdkTarballSha256: required('CROSSREPO_SDK_SHA'),
  fixtureSha256: {
    provider: sha(join(platformRoot, 'test/e2e/provider.mjs')),
    controls: sha(join(platformRoot, 'test/e2e/stack-controls.mjs')),
    appDriver: sha(fileURLToPath(new URL('./app-driver.mjs', import.meta.url))),
    runner: sha(import.meta.filename),
    runScript: sha(join(harnessDirectory, 'run.sh')),
    fixturePatch: sha(join(harnessDirectory, 'fixtures.patch')),
    offlineNetworkGuard: sha(join(platformRoot, 'test/fixtures/offline-network.cjs')),
  },
  stackLaunch: {
    command: required('CROSSREPO_STACK_LAUNCH'),
    environment: {
      PROTO_E2E_ARTIFACTS: required('PROTO_E2E_ARTIFACTS'),
      PROTO_E2E_ISOLATED: required('PROTO_E2E_ISOLATED'),
      NODE_OPTIONS: required('NODE_OPTIONS'),
    },
  },
  node: process.version,
};
const transcript = [];
try {
  const result = await runAppJourney({ stackDirectory, stackState: state, control, transcript });
  writeFileSync(join(root, 'result.json'), JSON.stringify({ ...manifest, passed: true, result }, null, 2));
  console.log(JSON.stringify({ passed: true, provider: result.provider, transcript }, null, 2));
} catch (error) {
  writeFileSync(join(root, 'result.json'), JSON.stringify({ ...manifest, passed: false,
    error: String(error), stack: error?.stack, transcript }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(stackDirectory, 'stop'), '');
}
