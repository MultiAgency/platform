import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:https';
import { environment } from './environment.mjs';

// The gateway listens on the wildcard `::`. On macOS another process can also listen on 127.0.0.1 at that port, before
// or after the gateway, and then takes every connection to 127.0.0.1:port: a browser's DevTools endpoint once did, and a
// case's page showed only "WebSockets request was expected" (docs/testing.md). The dashboard URL must reach the gateway.
test('the dashboard reaches the gateway even when another process listens on 127.0.0.1 at its port', async ({}, info) => {
  const stack = await environment(info.outputPath('environment'));
  const squatter = createServer((_, res) => res.end('WebSockets request was expected'));
  try {
    const port = Number(readFileSync(join(info.outputPath('environment'), 'gateway.log'), 'utf8').match(/on port (\d+)/)[1]);
    // Linux refuses this bind (the gateway's `::` holds 127.0.0.1 there too): no squatter, and the gateway must answer.
    await new Promise((resolve, reject) => {
      squatter.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
      squatter.listen(port, '127.0.0.1', resolve);
    });
    const body = await new Promise((resolve, reject) => request(`${stack.dashboard}/health`, { rejectUnauthorized: false }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(text));
    }).on('error', reject).end());
    expect(JSON.parse(body)).toEqual({ ok: true });
  } finally {
    squatter.close(); await stack.close();
  }
});
