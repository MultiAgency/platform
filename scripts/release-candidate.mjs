// One command for a release candidate: freeze a commit, build the frontend once, run every gate against that build,
// and package the deploy sources from it. Writes release.json with every digest. Runs locally only: it deploys nothing,
// uses no credentials and touches no state directory.
//
//   pnpm release:candidate -- [--ref <commit>] [--sdk] <the run.mjs inputs for a plain run>
//     e.g. --invoices-dist-release H --invoices-dist-next I --payables-dist A4 --payables-dist-next A5 --payables-change <label>
//          --treasury-dist A5 --treasury-dist-next A6 --treasury-change <label> --treasury-skill <dir>
//
// Stops at the first failing gate and packages nothing. The candidate is
// .test-artifacts/stack-snapshots/<runDigest>/ (app recipes use it as before); the deploy sources and release.json are
// in .test-artifacts/releases/<runDigest>/. Only committed files are frozen: commit first.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dependencyTree } from './dependency-tree.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2).filter(arg => arg !== '--');
const take = flag => { const i = args.indexOf(flag); if (i === -1) return undefined; const [, value] = args.splice(i, 2); return value; };
const ref = take('--ref') ?? 'HEAD';
const sdk = args.includes('--sdk') && Boolean(args.splice(args.indexOf('--sdk'), 1));
// App inputs are directories; gates run inside the frozen snapshot, so each is resolved against the caller's directory.
const PATH_INPUTS = new Set(['--invoices-dist-release', '--invoices-dist-next', '--payables-dist', '--payables-dist-next',
  '--treasury-dist', '--treasury-dist-next', '--treasury-skill']);
const inputs = args.map((arg, i) => PATH_INPUTS.has(args[i - 1]) ? resolve(arg) : arg);
const flag = name => { const i = inputs.indexOf(name); return i === -1 ? undefined : resolve(inputs[i + 1]); };
const required = ['--invoices-dist-release', '--invoices-dist-next', '--payables-dist', '--payables-dist-next', '--payables-change',
  '--treasury-dist', '--treasury-dist-next', '--treasury-change', '--treasury-skill'];
const missing = required.filter(name => !inputs.includes(name));
if (missing.length) throw new Error(`A candidate runs every case; missing: ${missing.join(', ')}`);
// Release B of each app is what ships; release A is what it replaces.
const shipped = { payables: flag('--payables-dist-next'), treasury: flag('--treasury-dist-next') };

/** The same directory digest as test/e2e/run.mjs (and the stack-snapshot names). */
function digest(dir, skip = ['.test-artifacts', 'SNAPSHOT.json']) {
  const hash = createHash('sha256');
  (function scan(path, prefix = '') {
    for (const file of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + file.name;
      if (!prefix && skip.includes(file.name)) continue;
      if (file.isDirectory()) scan(join(path, file.name), name + '/');
      else if (file.isFile()) hash.update(name).update('\0').update(readFileSync(join(path, file.name))).update('\0');
    }
  })(dir);
  return hash.digest('hex');
}
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (...rest) => execFileSync('git', ['-C', root, ...rest], { encoding: 'utf8' }).trim();
const started = new Date().toISOString();
const record = { version: 1, startedAt: started, ref, commit: git('rev-parse', ref), node: process.version, gates: {} };
if (ref === 'HEAD' && git('status', '--porcelain', '--untracked-files=no')) console.warn('Uncommitted changes to tracked files are not in this candidate: it freezes the commit only.');

// 1. Freeze the commit. node_modules is shared (a symlink); the dependency tree is pinned instead.
const snapshots = join(root, '.test-artifacts/stack-snapshots'), staging = join(snapshots, `staging-${process.pid}`);
mkdirSync(staging, { recursive: true });
execFileSync('sh', ['-c', `git -C "${root}" archive "${record.commit}" | tar -x -C "${staging}"`]);
symlinkSync(join(root, 'node_modules'), join(staging, 'node_modules'), 'dir');
const env = { ...process.env, NODE_ENV: 'production' };
let workdir = staging;
function gate(name, command, commandArgs, read) {
  console.log(`\n== ${name}: ${[command, ...commandArgs].join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(output.split('\n').filter(line => /^(ℹ (tests|pass|fail)|✖ |.*scenarios ran|.*suite\(s\) failed|\s+\d+ (passed|failed|skipped)|Challenge |FAIL|Error)/.test(line)).join('\n') + '\n');
  mkdirSync(join(workdir, '.test-artifacts/release-gates'), { recursive: true });
  writeFileSync(join(workdir, '.test-artifacts/release-gates', `${name}.log`), output);
  record.gates[name] = { command: [command, ...commandArgs].join(' '), status: result.status, ...(read?.(output) ?? {}) };
  if (result.status !== 0) {
    record.result = `failed at ${name}`;
    writeFileSync(join(workdir, 'RELEASE-FAILED.json'), JSON.stringify(record, null, 2) + '\n');
    console.error(`\n${name} failed (exit ${result.status}); nothing is packaged. Logs: ${join(workdir, '.test-artifacts/release-gates')}`);
    process.exit(1);
  }
}
const e2eRun = output => {
  const dir = output.match(/Isolated E2E release and evidence: (\S+)/)?.[1];
  const stats = dir && existsSync(join(dir, 'results.json')) ? JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).stats : null;
  const manifest = dir && existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : null;
  return { run: dir?.split('/').at(-1), stats, assets: manifest?.assets, challenges: [...output.matchAll(/^Challenge (\S+): (\S+)/gm)].map(([, id, outcome]) => ({ id, outcome })) };
};

// 2. Gates, all against this one build of the frontend.
gate('typecheck', 'pnpm', ['-s', 'typecheck']);
gate('offline', process.execPath, ['scripts/test.mjs', 'offline'], output => ({ tests: Number(output.match(/^ℹ tests (\d+)/m)?.[1]), pass: Number(output.match(/^ℹ pass (\d+)/m)?.[1]), fail: Number(output.match(/^ℹ fail (\d+)/m)?.[1]) }));
gate('evidence', 'pnpm', ['-s', 'evidence:check']);
gate('build-web', join(staging, 'node_modules/.bin/rsbuild'), ['build', '--root', 'web']);
record.frontend = { source: digest(join(staging, 'web/src')), build: digest(join(staging, 'web/dist')) };
gate('browser', process.execPath, ['test/browser/run.cjs'], output => ({
  scenarios: [...output.matchAll(/^(\S+): (\d+) of (\d+) scenarios ran/gm)].map(([, suite, ran, of]) => ({ suite, ran: Number(ran), of: Number(of) })),
  failedSuites: Number(output.match(/(\d+) browser suite\(s\) failed/)?.[1]) }));
gate('e2e', process.execPath, ['test/e2e/run.mjs', '--prebuilt-web', ...inputs], e2eRun);
gate('challenges', process.execPath, ['test/e2e/run.mjs', '--challenge', '--prebuilt-web', ...inputs], e2eRun);
for (const name of ['e2e', 'challenges']) {
  const assets = record.gates[name].assets;
  if (assets !== record.frontend.build) throw new Error(`${name} tested frontend ${assets}, not the candidate's build ${record.frontend.build}`);
}

// 3. Freeze under the run digest (the name recipes use), with the record beside it.
record.dependencyTree = dependencyTree(staging);
const runDigest = digest(staging);
const snapshot = join(snapshots, runDigest);
if (existsSync(snapshot)) throw new Error(`${snapshot} already exists; the same commit was frozen before. Use it.`);
// sourceHead/overlayDiffSha256 are what scripts/contract-pack.ts reads for SDK provenance; a commit has no overlay.
writeFileSync(join(staging, 'SNAPSHOT.json'), JSON.stringify({ runDigest, sourceHead: record.commit, overlayDiffSha256: null, dependencyTree: record.dependencyTree, frontend: record.frontend, node: record.node, frozenAt: new Date().toISOString() }, null, 2) + '\n');
renameSync(staging, snapshot);
workdir = snapshot;
// The SDK is packed from the frozen snapshot, so its provenance names it.
if (sdk) gate('sdk', 'pnpm', ['-s', 'contract:pack']);
if (sdk) gate('sdk-skills', 'pnpm', ['-s', 'contract:skills']);

// 4. Deploy sources, from the snapshot and the shipped app releases only.
const out = join(root, '.test-artifacts/releases', runDigest);
mkdirSync(out, { recursive: true });
execFileSync(process.execPath, ['scripts/package-shared-frontends.mjs', join(out, 'dao'), shipped.treasury, shipped.payables], { cwd: snapshot, stdio: 'inherit' });
const invoices = join(out, 'invoices');
mkdirSync(invoices);
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'src', 'Dockerfile.payouts', 'railway.json']) cpSync(join(snapshot, name), join(invoices, name), { recursive: true });
writeFileSync(join(invoices, '.dockerignore'), 'node_modules\n');
if (digest(join(out, 'dao/web/dist'), []) !== record.frontend.build) throw new Error('The packaged frontend differs from the tested build');
// The platform: the headless engine, with the confirm page's files alone, each byte-equal to the tested build's.
execFileSync(process.execPath, ['scripts/package-platform.mjs', join(out, 'platform')], { cwd: snapshot, stdio: 'inherit' });
const platformFiles = JSON.parse(readFileSync(join(out, 'platform/manifest.json'), 'utf8')).files;
for (const [file, hash] of Object.entries(platformFiles))
  if (file.startsWith('web/dist/') && hash !== sha256(join(snapshot, file))) throw new Error(`The platform package's ${file} differs from the tested build`);

record.runDigest = runDigest;
record.snapshot = snapshot;
record.inputs = Object.fromEntries(required.filter(name => !name.endsWith('-change')).map(name => [name.slice(2), { path: flag(name), digest: digest(flag(name), []) }]));
record.changes = { payables: inputs[inputs.indexOf('--payables-change') + 1], treasury: inputs[inputs.indexOf('--treasury-change') + 1] };
record.packages = { dao: { path: join(out, 'dao'), manifestSha256: sha256(join(out, 'dao/manifest.json')), treasury: digest(shipped.treasury, []), payables: digest(shipped.payables, []) },
  platform: { path: join(out, 'platform'), manifestSha256: sha256(join(out, 'platform/manifest.json')) },
  invoices: { path: invoices, sourceDigest: digest(invoices, []) } };
if (sdk) {
  const pack = readdirSync(join(snapshot, '.test-artifacts/contract')).find(name => name.endsWith('.tgz'));
  record.sdk = { tarball: join(snapshot, '.test-artifacts/contract', pack), sha256: sha256(join(snapshot, '.test-artifacts/contract', pack)) };
}
record.result = 'passed';
record.finishedAt = new Date().toISOString();
writeFileSync(join(out, 'release.json'), JSON.stringify(record, null, 2) + '\n');
console.log(`\nCandidate ${runDigest} passed every gate.\nSnapshot: ${snapshot}\nDeploy sources and release.json: ${out}`);
