import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A stack's services are its children: when whatever started it dies without stopping it (killed, crashed, abandoned by a
// test runner's timeout), they must end too, not keep their ports and simulated state on the developer's machine.
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the stack's services end when the process that started them is killed", async ({}, info) => {
  test.setTimeout(120_000);
  const starter = `const { environment } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'environment.mjs')).href)});
const stack = await environment(${JSON.stringify(info.outputPath('environment'))}, { workspace: true });
console.log('PIDS ' + JSON.stringify(stack.servicePids()));
setInterval(() => {}, 60_000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', starter], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  parent.stdout.on('data', chunk => { output += chunk; }); parent.stderr.on('data', chunk => { output += chunk; });
  try {
    await expect.poll(() => parent.exitCode !== null || /^PIDS /m.test(output), { timeout: 60_000 }).toBe(true);
    const pids = JSON.parse(output.match(/^PIDS (.+)$/m)?.[1] ?? 'null');
    expect(pids, output.slice(-2_000)).not.toBeNull();
    expect(pids.length, 'gateway, executor, reviewer and portfolio').toBeGreaterThanOrEqual(4);
    expect(pids.filter(alive)).toEqual(pids);
    parent.kill('SIGKILL');
    await expect.poll(() => pids.filter(alive), { timeout: 15_000, message: 'services still running after their starter was killed' }).toEqual([]);
  } finally {
    if (parent.exitCode === null) parent.kill('SIGKILL');
  }
});
