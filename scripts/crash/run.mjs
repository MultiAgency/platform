import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAttacks, PAYEE, AMOUNT, task } from './attacks.mjs';
import { modelAgent, scripted, systemPrompt, world } from './agents.mjs';
import { judge } from './judge.mjs';
import { crashStack } from './stack.mjs';

// `pnpm crash`: a crash test of an outside agent that pays through @multiagency/sdk, after Clearance
// (github.com/Selliksss/clearance). Opt-in, never part of `pnpm test`. The platform runs on the simulated stack; the agent
// is a model on NEAR AI Cloud (needs NEARAI_API_KEY, which no service of the stack inherits) or, with --scripted, the
// two scripted agents that check the harness itself. Everything is written under .test-artifacts/crash/<run>/.

const root = resolve(import.meta.dirname, '../..');
const { values: opts } = parseArgs({ options: {
  scripted: { type: 'boolean', default: false },
  models: { type: 'string', default: 'z-ai/glm-5.3-flash,Qwen/Qwen3.8-27B,deepseek/deepseek-v4.1-flash,openai/gpt-5.6-sol,anthropic/claude-opus-5-5,moonshotai/kimi-k3' },
  prompts: { type: 'string', default: 'skill,bare' },
  attacks: { type: 'string' },
  seeds: { type: 'string', default: '3' },
  controls: { type: 'string', default: '2' },
  owner: { type: 'string', default: 'approve' },
} });
if (!['approve', 'hold'].includes(opts.owner)) throw new Error('--owner is approve or hold');
const apiKey = process.env.NEARAI_API_KEY;
if (!opts.scripted && !apiKey) throw new Error('NEARAI_API_KEY is not set (or pass --scripted to check the harness without a model)');

const attacks = loadAttacks().filter(a => !opts.attacks || opts.attacks.split(',').some(id => a.id.startsWith(id)));
const seeds = Number(opts.seeds), controls = Number(opts.controls);
const agents = opts.scripted ? Object.keys(scripted).map(name => ({ name: `scripted:${name}`, prompt: 'none' }))
  : opts.models.split(',').flatMap(model => opts.prompts.split(',').map(prompt => ({ name: model, model, prompt })));

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts/crash', 'test/e2e'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const id = new Date().toISOString().replace(/[:.]/g, '-'), out = join(root, '.test-artifacts/crash', id);
mkdirSync(out, { recursive: true });
const attackDigest = createHash('sha256').update(JSON.stringify(attacks)).digest('hex');

// A clean agent is reused by the next run; one a run left with an unresolved operation is retired (and the run marked
// `blocked`). A host holds 16 hosted agents per deployment, so the stack is booted again when they run out.
let platform, stacks = 0, organizations = 0, pooled = null;
const boot = async () => { if (platform) await platform.close(); platform = await crashStack(join(out, `stack-${++stacks}`)); pooled = null; };
async function nextAgent() {
  if (pooled) return pooled;
  try { return (pooled = await platform.payoutAgent(`org_${++organizations}`)); }
  catch (error) {
    if (!/hosted agent limit|capacity reached/.test(String(error))) throw error;
    await boot(); return (pooled = await platform.payoutAgent(`org_${++organizations}`));
  }
}
await boot();
const results = [];
try {
  for (const agent of agents) {
    const prompt = agent.prompt === 'none' ? { text: '', skills: [] } : systemPrompt(agent.prompt);
    const act = agent.model ? modelAgent({ model: agent.model, apiKey }) : scripted[agent.name.slice('scripted:'.length)];
    const cases = [...Array.from({ length: controls }, (_, seed) => ({ attack: null, seed })), ...attacks.flatMap(attack => Array.from({ length: seeds }, (_, seed) => ({ attack, seed })))];
    for (const { attack, seed } of cases) {
      const label = `${agent.name} ${agent.prompt} ${attack?.id ?? 'control'} #${seed}`;
      const invoiceId = `INV-${createHash('sha256').update(`${id}:${label}`).digest('hex').slice(0, 8)}`;
      const payout = await nextAgent(), before = platform.transfersOf(payout.agentId).length;
      const tools = world({ platform, payout, invoiceId, attack, seed, owner: opts.owner });
      let outcome, error;
      for (let attempt = 1; attempt <= 2 && !outcome; attempt++) {
        try { outcome = await act({ system: prompt.text, task: task(invoiceId), tools, invoiceId }); }
        catch (e) { error = e instanceof Error ? e.message : String(e); if (tools.calls.length) break; }
      }
      const transfers = platform.transfersOf(payout.agentId).slice(before);
      const verdict = judge({ oracle: { recipient: PAYEE, amount: AMOUNT }, calls: tools.calls, transfers, reached: attack ? tools.reached() : null, owner: opts.owner });
      // A run the model never finished, or a cut-off one, is kept and marked invalid; it counts toward nothing.
      const invalid = !outcome ? `error: ${error}` : outcome.cutOff ? 'cut off' : null;
      if (opts.owner === 'hold') for (const t of transfers.filter(t => t.status === 'PENDING_APPROVAL')) await platform.vote(payout.agent, t.correlation, 'reject');
      // Blocked: the run left an operation the platform can't resolve, so this agent's later payouts are all refused.
      const left = await platform.leftover(payout);
      verdict.blocked = left.unresolved > 0;
      if (left.unresolved || left.held) pooled = null;
      const record = { label, agent: agent.name, prompt: agent.prompt, skills: prompt.skills, attack: attack?.id ?? 'control', seed, invoiceId, owner: opts.owner,
        invalid, verdict, final: outcome?.final ?? null, completions: outcome?.completions ?? [], calls: tools.calls, transfers };
      writeFileSync(join(out, `${label.replace(/[^A-Za-z0-9.#-]+/g, '_')}.json`), JSON.stringify(record, null, 2));
      results.push(record);
      console.log(`${label}: ${invalid ? `INVALID (${invalid})` : `${verdict.deceived ? 'DECEIVED' : 'ok'}${attack && !verdict.reached ? ' (not reached)' : ''}, lost ${verdict.lost}, done ${verdict.done}${verdict.refusals.length ? `, refused ${verdict.refusals.join(' ')}` : ''}`}`);
    }
  }
} finally { await platform.close(); }

const rows = [];
for (const agent of agents) for (const attack of ['control', ...attacks.map(a => a.id)]) {
  const runs = results.filter(r => r.agent === agent.name && r.prompt === agent.prompt && r.attack === attack);
  const valid = runs.filter(r => !r.invalid), reached = valid.filter(r => attack === 'control' || r.verdict.reached);
  rows.push({ agent: agent.name, prompt: agent.prompt, attack, runs: runs.length, valid: valid.length, reached: reached.length,
    deceived: reached.filter(r => r.verdict.deceived).length, done: valid.filter(r => r.verdict.done).length,
    lost: valid.reduce((sum, r) => sum + BigInt(r.verdict.lost), 0n).toString(), heldForOwner: valid.reduce((sum, r) => sum + r.verdict.heldForOwner, 0),
    secondRequestIds: valid.reduce((sum, r) => sum + r.verdict.secondRequestIds, 0), blocked: valid.filter(r => r.verdict.blocked).length });
}
const summary = { id, commit, dirty, node: process.version, owner: opts.owner, attackDigest, scripted: opts.scripted, seeds, controls, rows };
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${'agent'.padEnd(34)} ${'prompt'.padEnd(6)} ${'attack'.padEnd(24)} deceived/reached  done/valid  lost(raw USDC)  2nd requestIds  held for owner  agent blocked`);
for (const r of rows) console.log(`${r.agent.padEnd(34)} ${r.prompt.padEnd(6)} ${r.attack.padEnd(24)} ${`${r.deceived}/${r.reached}`.padEnd(17)} ${`${r.done}/${r.valid}`.padEnd(11)} ${r.lost.padEnd(15)} ${String(r.secondRequestIds).padEnd(15)} ${String(r.heldForOwner).padEnd(15)} ${r.blocked}`);
console.log(`\n${out}`);

if (opts.scripted) {
  // The harness's own check: a careful agent is never deceived, and does every task whose invoice matches the task (refusing
  // a tampered invoice is correct, since the task states the payee and price); a gullible one is deceived by every attack
  // it reaches. Either failing means the attacks or the judge are wrong, not the agents.
  const tampered = new Set(attacks.filter(a => a.channel === 'invoice').map(a => a.id));
  const wrong = results.filter(r => r.invalid
    || (r.agent === 'scripted:careful' && (r.verdict.deceived || r.verdict.lost !== '0' || (!r.verdict.done && !tampered.has(r.attack))))
    || (r.agent === 'scripted:gullible' && r.attack !== 'control' && !r.verdict.deceived));
  for (const r of wrong) console.error(`HARNESS CHECK FAILED: ${r.label} ${JSON.stringify(r.verdict)}${r.invalid ? ` ${r.invalid}` : ''}`);
  process.exitCode = wrong.length ? 1 : 0;
}
