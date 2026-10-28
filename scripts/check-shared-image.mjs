// Execute inside the release image with --network none and no production volume or credentials.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('/app/release-manifest.json', 'utf8'));
let checked = 0;
for (const [path, hash] of Object.entries(manifest.files)) {
  if (!/^(src\/|web\/|frontends\/|deploy\/|package.json$|pnpm-|tsconfig.json$)/.test(path)) continue;
  assert.equal(createHash('sha256').update(readFileSync(join('/app', path))).digest('hex'), hash, path);
  checked++;
}
const config = JSON.parse(readFileSync('/app/deploy/shared-frontends.json', 'utf8'));
assert.equal(config.agents.find(a => a.name === 'payout').executor, false);
assert.equal(config.agents.find(a => a.name === 'payout').invoices, 'https://invoices.multiagency.ai/submit');
assert.equal(config.agents.filter(a => a.executor !== false).length, 1);
assert.equal(config.hosts['treasury.multiagency.ai'].frontendDist, '/app/frontends/treasury');
assert.equal(config.hosts['payables.multiagency.ai'].frontendDist, '/app/frontends/payables');
// Preserve host mappings/build paths. Replace only live assignments with empty offline fixtures.
config.agents = []; delete config.invoiceUpstream;
for (const site of Object.values(config.hosts)) site.agents = [];
const data = mkdtempSync('/tmp/shared-image-');
const state = join(data, 'state'); mkdirSync(state);
// The canonical state directories (docs/operations.md); test/state-directories.test.ts keeps this list equal to it.
const kept = ['.ops', '.invoices', '.owner-intents', '.strategy', '.plans', '.evidence', '.inbox', '.agreements', '.notify', '.work-orders', '.hosted', '.agent-connections', '.machine-auth', '.app-access'];
for (const dir of kept) { mkdirSync(join(state, dir)); writeFileSync(join(state, dir, 'preserve'), `retained ${dir}`); }
writeFileSync(join(state, '.hosted/registry.json'), '{"version":1,"entries":[]}');
writeFileSync(join(state, '.env.dao'), 'retained treasury settings');
writeFileSync(join(state, '.env.payout'), 'retained payout settings');
writeFileSync(join(data, 'dashboard.json'), JSON.stringify(config));
const call = (host, path) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port: 8080, path, headers: { host } }, res => {
    const parts = []; res.on('data', x => parts.push(x)).on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
  }); req.on('error', reject); req.end();
});
let child;
const stop = async () => { if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } };
try {
  for (let boot = 0; boot < 2; boot++) {
    child = spawn('/app/deploy/dashboard-entrypoint.sh', [], { env: {
      PATH: process.env.PATH, HOME: '/tmp', DATA_DIR: data, PORT: '8080', NODE_ENV: 'test',
      DASHBOARD_FILE: join(data, 'dashboard.json'), SESSION_SECRET: 'offline-image-session-secret-123456789',
      NEAR_INTENTS_AGENT_API_KEY: 'naa_' + 'x'.repeat(43), NEAR_INTENTS_AGENT_API_URL: 'http://127.0.0.1:9', NEAR_RPC_URL: 'http://127.0.0.1:9',
      DAO_ENV: Buffer.from('must not replace').toString('base64'), PAYOUT_ENV: Buffer.from('must not replace').toString('base64'),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; child.stderr.on('data', chunk => logs += chunk);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(logs || 'startup timeout')), 15000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('on port')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${logs}`)); });
    });
    for (const area of ['proto', 'treasury', 'payables']) {
      const host = `${area}.multiagency.ai`, root = area === 'proto' ? '/app/web/dist' : `/app/frontends/${area}`;
      const expected = readFileSync(join(root, 'index.html'));
      const page = await call(host, '/'); assert.equal(page.status, 200); assert.deepEqual(page.body, expected);
      const paths = [...expected.toString().matchAll(/(?:src|href)="(\/static\/[^"?#]+)"/g)].map(m => m[1]);
      assert.ok(paths.length > 0);
      for (const path of paths) { const asset = await call(host, path); assert.equal(asset.status, 200); assert.deepEqual(asset.body, readFileSync(join(root, path))); }
      const discovery = await call(host, '/gw/me'); assert.equal(discovery.status, 200);
      assert.deepEqual(JSON.parse(discovery.body).agents, []);
    }
    assert.equal((await call('unknown.test', '/')).status, 421);
    assert.equal((await call('unknown.test', '/health')).status, 200);
    assert.equal((await call('invoices.multiagency.ai', '/i/own-' + 'f'.repeat(24) + '/?workOrder=exact')).status, 404);
    assert.match((await call('invoices.multiagency.ai', '/')).body.toString(), /contributor link/);
    await stop();
    for (const dir of kept) assert.equal(readFileSync(join(state, dir, 'preserve'), 'utf8'), `retained ${dir}`);
    assert.equal(readFileSync(join(state, '.env.dao'), 'utf8'), 'retained treasury settings');
    assert.equal(readFileSync(join(state, '.env.payout'), 'utf8'), 'retained payout settings');
  }
  console.log(`PASS: ${checked} packaged hashes; three hosts and assets; isolated routing; two boots preserve fixture state and settings.`);
} finally { await stop(); rmSync(data, { recursive: true, force: true }); }
