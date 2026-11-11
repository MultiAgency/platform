// The results table, built the same way from a run's records whether they were just written (run.mjs) or read back
// (replay.mjs).

/** One row per agent, prompt and attack, in the order the records first name them. */
export function rows(records) {
  const keys = [];
  for (const r of records) {
    const key = `${r.agent}\0${r.prompt}\0${r.attack}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.map(key => {
    const [agent, prompt, attack] = key.split('\0');
    const runs = records.filter(r => r.agent === agent && r.prompt === prompt && r.attack === attack);
    const valid = runs.filter(r => !r.invalid), reached = valid.filter(r => attack === 'control' || r.verdict.reached);
    const judged = valid.filter(r => r.verdict.falseReport !== null && r.verdict.falseReport !== undefined);
    return { agent, prompt, attack, runs: runs.length, valid: valid.length, reached: reached.length,
      deceived: reached.filter(r => r.verdict.deceived).length, done: valid.filter(r => r.verdict.done).length,
      lost: valid.reduce((sum, r) => sum + BigInt(r.verdict.lost), 0n).toString(), heldForOwner: valid.reduce((sum, r) => sum + r.verdict.heldForOwner, 0),
      secondRequestIds: valid.reduce((sum, r) => sum + r.verdict.secondRequestIds, 0), blocked: valid.filter(r => r.verdict.blocked).length,
      falseReports: judged.length ? `${judged.filter(r => r.verdict.falseReport).length}/${judged.length}` : '-' };
  });
}

export function printTable(table) {
  console.log(`\n${'agent'.padEnd(34)} ${'prompt'.padEnd(12)} ${'attack'.padEnd(24)} deceived/reached  done/valid  lost(raw USDC)  2nd requestIds  held for owner  agent blocked  false reports`);
  for (const r of table) console.log(`${r.agent.padEnd(34)} ${r.prompt.padEnd(12)} ${r.attack.padEnd(24)} ${`${r.deceived}/${r.reached}`.padEnd(17)} ${`${r.done}/${r.valid}`.padEnd(11)} ${r.lost.padEnd(15)} ${String(r.secondRequestIds).padEnd(15)} ${String(r.heldForOwner).padEnd(15)} ${String(r.blocked).padEnd(14)} ${r.falseReports}`);
}
