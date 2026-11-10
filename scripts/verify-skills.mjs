// Verifies the SDK's Intent skills against the packed tarball, as a consumer gets them: installs it in an isolated
// project, typechecks every `ts` fence of the shipped SKILL.md files, runs each example against stand-in servers, and
// runs Intent's own validation and discovery. Usage: node scripts/verify-skills.mjs [--runtime bun] [tarball]
// With `--runtime bun` (`pnpm sdk:bun`) it installs the same consumer and runs only the examples' runner, under Bun:
// the typecheck and Intent's checks don't depend on the runtime and stay with the Node run.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { contractPackage: { version } } = await import(join(root, 'src/contract/package-version.ts'));
const args = process.argv.slice(2);
const runtime = args.includes('--runtime') ? args.splice(args.indexOf('--runtime'), 2)[1] : 'node';
if (!['node', 'bun'].includes(runtime)) throw new Error(`--runtime is node or bun, not ${runtime}`);
const tarball = resolve(args[0] ?? join(root, `.test-artifacts/contract/multiagency-sdk-${version}.tgz`));
const pin = name => manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
};

let bun;
if (runtime === 'bun') {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('SKIPPED: bun is not installed, so the packed SDK was not run under Bun. Install Bun and run `pnpm sdk:bun` again.');
    process.exit(0);
  }
  bun = probe.stdout.trim();
}

const consumer = mkdtempSync(join(tmpdir(), 'sdk-skills-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true, dependencies: {
    '@multiagency/sdk': `file:${tarball}`, zod: pin('zod'), '@orpc/client': pin('@orpc/client'), '@orpc/contract': pin('@orpc/contract'),
    '@orpc/server': pin('@orpc/server'), '@ag-ui/core': pin('@ag-ui/core'), typescript: pin('typescript'), '@types/node': pin('@types/node'), '@tanstack/intent': pin('@tanstack/intent') } }));
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], consumer);

  // 1. Every fence of the shipped skills, typechecked as its own module in a strict NodeNext consumer.
  const installed = join(consumer, 'node_modules/@multiagency/sdk/skills');
  const skills = readdirSync(installed).filter(name => !name.startsWith('_'));
  mkdirSync(join(consumer, 'examples'));
  const examples = [];
  for (const skill of skills) {
    const text = readFileSync(join(installed, skill, 'SKILL.md'), 'utf8');
    if (!text.includes(`library_version: '${version}'`)) throw new Error(`${skill}: library_version is not ${version}`);
    [...text.matchAll(/```ts\n([\s\S]*?)```/g)].forEach(([, code], index) => {
      const file = `examples/${skill}-${index + 1}.ts`;
      writeFileSync(join(consumer, file), code);
      examples.push(file);
    });
  }
  // The examples see no Node types (they run in a browser too); the runner below adds them.
  const compilerOptions = { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', lib: ['ES2023', 'DOM'], strict: true, noEmit: true,
    types: [], allowImportingTsExtensions: true };
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: examples }));
  writeFileSync(join(consumer, 'tsconfig.run.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, types: ['node'] }, files: ['run.ts'] }));

  // 2. Each example run against stand-ins: what it sends, how often, and what it answers.
  writeFileSync(join(consumer, 'run.ts'), readFileSync(join(root, 'scripts/verify-skills-run.ts'), 'utf8'));
  if (runtime === 'bun') {
    const ran = run('bun', ['run.ts'], consumer);
    console.log(JSON.stringify({ tarball, runtime: { bun }, examples: examples.length, ran: JSON.parse(ran) }, null, 2));
  } else {
    for (const config of ['tsconfig.json', 'tsconfig.run.json']) run(join(consumer, 'node_modules/.bin/tsc'), ['-p', config, '--pretty', 'false'], consumer);
    const ran = run(process.execPath, ['run.ts'], consumer);

    // 3. Intent's own checks: validation of the shipped skills with their maintenance artifacts, and discovery.
    let validation;
    const validated = mkdtempSync(join(tmpdir(), 'sdk-skills-validate-'));
    try {
      cpSync(installed, join(validated, 'skills'), { recursive: true });
      cpSync(join(root, 'src/contract/skills/_artifacts'), join(validated, 'skills/_artifacts'), { recursive: true });
      validation = run(join(consumer, 'node_modules/.bin/intent'), ['validate', join(validated, 'skills')], consumer);
    } finally { rmSync(validated, { recursive: true, force: true }); }
    const listed = run(join(consumer, 'node_modules/.bin/intent'), ['list'], consumer);
    for (const skill of skills) if (!listed.includes(skill)) throw new Error(`intent list does not show ${skill}:\n${listed}`);
    const loaded = run(join(consumer, 'node_modules/.bin/intent'), ['load', '@multiagency/sdk#getting-started'], consumer);
    if (!loaded.includes('# Working with MultiAgency agents')) throw new Error(`intent load did not print getting-started:\n${loaded}`);

    console.log(JSON.stringify({ tarball, skills, examples: examples.length, ran: JSON.parse(ran), intent: { validate: validation.split('\n'), list: skills, load: 'ok' } }, null, 2));
  }
} finally { rmSync(consumer, { recursive: true, force: true }); }
