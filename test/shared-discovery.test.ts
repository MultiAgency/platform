import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const enabled of [false, true]) test(`shared discovery advertises area boundaries with setup ${enabled ? 'enabled' : 'disabled'}`, { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-discovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', () => resolve((probe.address() as {port: number}).port)); });
  await new Promise<void>(resolve => probe.close(() => resolve()));
  writeFileSync(join(dir, 'dashboard.json'), JSON.stringify({ host: 'payables.test', selfService: enabled,
    agents: [{name:'payout', owner:'alice.near', area:'payables', port:9999, executor:false}],
    hosts: { 'payables.test': {demo:'payables', agents:['payout'], hostedAreas:['payables']}, 'other.test': {demo:'payables', agents:['payout']} } }));
  const child = spawn(process.execPath, ['--import', join(process.cwd(), 'node_modules/tsx/dist/loader.mjs'), join(process.cwd(), 'src/gateway/server.ts')], {cwd:dir, env:{...process.env, PORT:String(port),SESSION_SECRET:'offline-discovery-secret-'.repeat(3)},stdio:['ignore','pipe','pipe']});
  t.after(async () => { if(child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit',resolve)); } });
  let diagnostics=''; child.stderr!.on('data', chunk=>diagnostics+=chunk);
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${diagnostics}\n${output}`)), 8_000);
    child.stdout!.on('data', chunk => {
      output += chunk;
      if (output.includes('on port')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Gateway exited during startup (${code}, ${signal}): ${diagnostics}\n${output}`));
    });
  });
  for(const host of ['payables.test','other.test']) {
    const body = await new Promise<any>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/gw/me', headers: { host } }, res => {
        let data = ''; res.on('data', chunk => data += chunk).on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
        });
      }); req.on('error', reject); req.end();
    });
    assert.deepEqual(body.setupAreas,enabled && host==='payables.test'?['payables']:[]);
    assert.equal(body.selfService===true,enabled && host==='payables.test');
    assert.deepEqual(body.agents,[]);
  }
});
