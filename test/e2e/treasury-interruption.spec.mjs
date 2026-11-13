import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';
import { environment, strategyFixture } from './environment.mjs';
import { browserContext, connectWallet, machineAccess } from './wallet.mjs';
import { PAYEE, USDC } from './provider.mjs';

for (const fault of ['lost provider response', 'lost second response after first success', 'client killed after first success']) {
  test(`chosen swaps: ${fault} never duplicates submissions`, async ({ browser }, info) => {
    const skill = process.env.PROTO_E2E_TREASURY_SKILL;
    test.skip(!skill, 'Supply --treasury-skill for actual consumer acceptance.');
    const stack = await environment(info.outputPath('environment'), { workspace: true });
    const wallet = await browserContext(browser, stack, PAYEE);
    const children = []; let gate;
    try {
      const page = await wallet.context.newPage();
      await page.goto(`${stack.dashboard}/`);
      await connectWallet(page, PAYEE);
      const issued = await machineAccess(page, 'portfolio')('POST', '', { label: 'Offline interruption test', scopes: ['read', 'prepare', 'execute-plan'] });
      expect(issued.status).toBe(201);
      const token = issued.body.token;
      const env = { ...offlineEnvironment(), FORCE_COLOR: undefined, NODE_OPTIONS: process.env.NODE_OPTIONS,
        NODE_EXTRA_CA_CERTS: join(stack.directory, 'localhost.crt'), TREASURY_URL: stack.dashboard,
        TREASURY_NAME: 'portfolio', TREASURY_MACHINE_TOKEN: token };
      const start = (...args) => {
        const child = spawn(process.execPath, [join(skill, 'scripts/treasury.mjs'), ...args], { env });
        children.push(child); const output = { stdout: '', stderr: '' };
        child.stdout.on('data', chunk => { output.stdout += chunk; });
        child.stderr.on('data', chunk => { output.stderr += chunk; });
        const done = new Promise((resolve, reject) => { child.once('error', reject);
          child.once('close', (code, signal) => resolve({ ...output, code, signal })); });
        return { child, output, done };
      };
      const run = async (...args) => {
        const result = await start(...args).done;
        expect(result.stderr).not.toContain(token);
        return result;
      };
      await strategyFixture(stack, { targetBps: { [USDC]: 7500, 'nep141:wrap.near': 2500, 'nep141:eth.omft.near': 0 },
        minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 0 } });
      const swaps = ['3000000', '2000000'].map(amount => ({ from: USDC, to: 'nep141:wrap.near', amount }));
      const file = join(stack.directory, 'swaps.json'); writeFileSync(file, JSON.stringify({ swaps }));
      const prepared = await run('prepare', file); expect(prepared.code).toBe(0);
      const plan = JSON.parse(prepared.stdout);
      const lostAt = fault.startsWith('lost second') ? 2 : 1;
      if (fault.startsWith('lost')) stack.portfolio.dropSwapResponse(lostAt);
      else gate = stack.portfolio.pauseObservationAfterFirstSwap();
      const execution = start('execute', plan.id);
      if (gate) {
        await expect.poll(() => gate.reached).toBe(true);
        await expect.poll(() => execution.output.stdout.includes('SUCCESS')).toBe(true);
        expect(stack.portfolio.swaps).toHaveLength(1);
        execution.child.kill('SIGKILL');
        const killed = await execution.done; expect(killed.signal).toBe('SIGKILL');
        gate.release();
        // Killing the client does not stop the server's own execution of the plan: it submits the second leg once
        // observation resumes. Wait for it, so the replay below meets a finished run.
        await expect.poll(() => stack.portfolio.swaps.length).toBe(2);
      } else {
        const failed = await execution.done;
        expect(failed.code).toBe(1);
        expect(failed.stderr).toContain('outcome may be unknown');
        expect(stack.portfolio.swaps).toHaveLength(lostAt);
        if (lostAt === 2) expect(JSON.parse(failed.stdout.trim()).status).toBe('SUCCESS');
      }
      // This is an explicit adversarial replay, not an automatic client recovery action.
      const replay = await run('execute', plan.id); expect(replay.code).toBe(1);
      // Exactly one submission per leg the run reached, and none from the replay: both legs of the killed client's
      // plan (completed by the server), or every swap up to the lost response.
      const count = stack.portfolio.swaps.length;
      expect(count).toBe(gate ? 2 : lostAt);
      expect(stack.portfolio.swaps.map(swap => swap.body.amount)).toEqual(swaps.slice(0, count).map(swap => swap.amount));
      const actualPosts = () => stack.portfolio.requests.filter(r => r.method === 'POST' && r.path.endsWith('/swap') && !r.body.dry);
      expect(actualPosts()).toHaveLength(count);
      expect(new Set(actualPosts().map(r => r.key)).size).toBe(count);
      if (!gate) {
        const unresolved = await run('unresolved'); expect(unresolved.code).toBe(0);
        expect(JSON.parse(unresolved.stdout)).toHaveLength(1);
        const replacement = await run('prepare', file); expect(replacement.code).toBe(0);
        const refused = await run('execute', JSON.parse(replacement.stdout).id); expect(refused.code).toBe(1);
        expect(actualPosts()).toHaveLength(lostAt);
      }
      const journal = readFileSync(join(stack.directory, 'portfolio/.ops', `${stack.portfolio.id}.jsonl`), 'utf8');
      expect(journal).toContain(plan.id); expect(journal).not.toContain(token);
      writeFileSync(info.outputPath('interruption-result.json'), JSON.stringify({ fault, submissions: count,
        amounts: stack.portfolio.swaps.map(swap => swap.body.amount), replayCode: replay.code }, null, 2));
      expect(stack.portfolio.errors).toEqual([]); expect(wallet.unexpected).toEqual([]);
    } finally {
      gate?.release(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await wallet.context.close(); await stack.close();
    }
  });
}
