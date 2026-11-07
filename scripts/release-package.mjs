import { mkdirSync, readdirSync, lstatSync, copyFileSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * A new, immutable release package at `destination`: `copy` records each file's sha256, and `finish` writes the manifest
 * with the given Git revisions. Explicit inputs only: never package repository roots, credentials, volumes,
 * or node_modules.
 */
export function releasePackage(destination) {
  const output = resolve(destination);
  if (existsSync(output)) throw new Error('Destination must not exist; releases are immutable snapshots.');
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
  function finish(revisions) {
    writeFileSync(join(output, '.dockerignore'), 'node_modules\n');
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(),
      note: 'File hashes identify the packaged bytes. Git revisions alone do not include concurrent working-tree edits.',
      revisions, files }, null, 2) + '\n');
    console.log(output);
  }
  return { output, copy, finish };
}

/**
 * The commit `path`'s files come from: a frozen snapshot's recorded source head (as the SDK pack reads it), else the
 * HEAD of a repository rooted at `path`. A directory only inside another repository (a snapshot under the checkout's
 * `.test-artifacts/` without its record, an app build) has none: that checkout's HEAD names what it holds now.
 */
export function revision(path) {
  if (existsSync(join(path, 'SNAPSHOT.json'))) return JSON.parse(readFileSync(join(path, 'SNAPSHOT.json'), 'utf8')).sourceHead ?? null;
  const git = args => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try { return realpathSync(git(['rev-parse', '--show-toplevel'])) === realpathSync(path) ? git(['rev-parse', 'HEAD']) : null; } catch { return null; }
}
