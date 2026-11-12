import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { get } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from './environment.mjs';

async function health(url, directory) {
  return new Promise((resolve, reject) => {
    get(`${url}/health`, { ca: readFileSync(join(directory, 'localhost.crt')) }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
}

// Deliberately take probed ports after they are released, before either child binds. This is the timing an unrelated
// process can produce under parallel CI, and it exercises the real child processes and proxy routes.
async function startWithBlockedPorts(info, targets) {
  const blockers = [];
  let stack;
  try {
    stack = await environment(info.outputPath('environment'), {
      beforeServiceStart: async ports => {
        for (const [name, host] of targets) {
          const blocker = createServer();
          await new Promise((resolve, reject) => {
            blocker.once('error', reject);
            blocker.listen(ports[name], host, resolve);
          });
          blockers.push(blocker);
        }
      },
    });
    expect(stack.servicePids()).toHaveLength(3);
    expect(await health(stack.dashboard, stack.directory)).toBe(200);
    expect(await health(stack.invoices, stack.directory)).toBe(200);
  } finally {
    await stack?.close();
    await Promise.all(blockers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

test('executor and reviewer start after a concurrent bind', async ({}, info) => {
  test.setTimeout(120_000);
  await startWithBlockedPorts(info, [['executorPort', '127.0.0.1'], ['reviewerPort', '127.0.0.1']]);
});

test('invoice server and its proxy follow a new port after a concurrent bind', async ({}, info) => {
  test.setTimeout(120_000);
  await startWithBlockedPorts(info, [['invoicePort', '::1']]);
});
