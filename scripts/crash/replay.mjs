import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { judgeRecord } from './judge.mjs';
import { printTable, rows } from './report.mjs';

// `pnpm crash:replay <run directory>`: judges every record of a run again from what it holds, offline, with no stack and
// no model. A stored verdict that differs from the current judge on any field it recorded is listed and fails the
// replay; fields a later judge added (falseReport, claim) are reported, not compared. Prints the run's table from the
// re-judged records, false reports included where the task asked for a claim. With --rescore, a changed verdict is
// written back, and the one it replaces is kept beside it (`rescored`), so the change stays on record.

const args = process.argv.slice(2), rescore = args.includes('--rescore'), dir = args.find(arg => arg !== '--rescore');
if (!dir) throw new Error('Usage: pnpm crash:replay <run directory> [--rescore]');
const files = readdirSync(resolve(dir)).filter(name => name.endsWith('.json') && name !== 'summary.json').sort();
if (!files.length) throw new Error(`No records in ${dir}`);

const records = [], changed = [];
for (const name of files) {
  const record = JSON.parse(readFileSync(join(resolve(dir), name), 'utf8'));
  const verdict = judgeRecord(record);
  const stored = record.verdict ?? {};
  const differs = Object.keys(stored).filter(key => JSON.stringify(stored[key]) !== JSON.stringify(verdict[key]));
  if (differs.length) {
    changed.push(`${name}: ${differs.map(key => `${key} ${JSON.stringify(stored[key])} → ${JSON.stringify(verdict[key])}`).join('; ')}`);
    if (rescore) writeFileSync(join(resolve(dir), name), JSON.stringify({ ...record, verdict, rescored: [...(record.rescored ?? []), { verdict: stored }] }, null, 2));
  }
  records.push({ ...record, verdict });
}

const table = rows(records);
printTable(table);
// The run's summary keeps the table its records now give, and says it was rescored.
if (rescore && changed.length) {
  const path = join(resolve(dir), 'summary.json');
  const summary = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...summary, rows: table, rescored: [...(summary.rescored ?? []), { records: changed.length, rows: summary.rows }] }, null, 2));
}
const judged = records.filter(r => !r.invalid && r.verdict.falseReport !== null);
console.log(`\n${records.length} records, ${records.filter(r => r.invalid).length} invalid; false reports judged on ${judged.length} (tasks that asked for a claim)`);
for (const line of changed) console.error(`${rescore ? 'RESCORED' : 'VERDICT CHANGED'} ${line}`);
process.exitCode = changed.length && !rescore ? 1 : 0;
