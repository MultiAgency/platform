import { expect } from '@playwright/test';
import { RPCJsonSerializer } from '@orpc/client';
import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { ownerClient } from '../../src/contract/owner-client.ts';
import { ownerOutputs, ownerStreams } from '../../src/contract/owner-outputs.ts';
import { READS } from '../../src/contract/permissions.ts';

// Real-traffic conformance: every owner RPC answer the app's own UI receives is decoded with oRPC's serializer
// and must parse against the published schema without losing or changing anything (no stripped fields).
const serializer = new RPCJsonSerializer();
// The RPC wire is `{ json, meta }`; an empty body is a procedure that returned nothing.
const decode = text => text === '' ? undefined : serializer.deserializeJson(JSON.parse(text));
/** One value per message: a `data:` block without an event name (or `event: message`); `close`/`done` are not events. */
const blocks = text => text.split('\n\n').map(block => ({ event: block.match(/^event: (.+)$/m)?.[1] ?? 'message', data: block.match(/^data: (.*)$/m)?.[1] }));
const events = text => blocks(text).flatMap(({ event, data }) => event === 'message' && data ? [decode(data)] : []);
const procedureOf = url => new URL(url).pathname.match(/^\/a\/[a-z0-9-]+\/rpc\/(.+)$/)?.[1];

function check(results, procedure, values) {
  for (const value of values) {
    const parsed = ownerOutputs[procedure].safeParse(value);
    const same = parsed.success && isDeepStrictEqual(parsed.data, value);
    results.push({ procedure, ok: same, issues: parsed.success ? (same ? null : 'parsed value differs (stripped or transformed)') : parsed.error.issues.slice(0, 3) });
  }
}

/** Await `ready` before the page loads; `settle` before reading `results` and before any navigation that follows an answer. */
export function recordConformance(page) {
  const results = [], aborted = [];
  // The page reads a clone of every 200 owner-RPC answer to its end (the app's own reader is untouched) and hands the
  // text to the test, so recording never depends on the browser retaining a body across navigation.
  const ready = Promise.all([
    page.exposeBinding('__conformanceAnswer', (_source, { url, stream, text, error }) => {
      const procedure = procedureOf(url);
      if (!procedure || !(procedure in ownerOutputs)) return;
      // The app cancelled its own request (an AbortSignal, e.g. a query that was rescoped or unmounted): no answer
      // was delivered to check. Counted, never a pass. Any other unreadable body is a failure.
      if (error !== undefined && /^AbortError\b/.test(error)) { aborted.push(procedure); return; }
      if (error !== undefined) { results.push({ procedure, ok: false, issues: `body unreadable: ${error}` }); return; }
      check(results, procedure, stream ? events(text) : [decode(text)]);
    }),
    page.addInitScript(() => {
      const original = window.fetch;
      window.__conformanceOutstanding = 0;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (response.status === 200 && /^\/a\/[a-z0-9-]+\/rpc\//.test(new URL(response.url).pathname)) {
          const stream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
          window.__conformanceOutstanding++;
          response.clone().text().then(text => window.__conformanceAnswer({ url: response.url, stream, text }),
            error => window.__conformanceAnswer({ url: response.url, stream, error: String(error) }))
            .finally(() => { window.__conformanceOutstanding--; });
        }
        return response;
      };
    }),
  ]);
  const settle = async () => {
    const deadline = Date.now() + 15_000;
    while ((await page.evaluate(() => window.__conformanceOutstanding ?? 0)) > 0) {
      if (Date.now() > deadline) { results.push({ procedure: 'unknown', ok: false, issues: 'answers still unread after 15s' }); return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  return { results, aborted, ready, settle };
}

const isStream = answer => (answer.headers.find(([k]) => k === 'content-type')?.[1] ?? '').includes('text/event-stream');
/** The encoded error a raw answer carries: a 4xx/5xx body, or a stream's `event: error`. */
const rawError = answer => {
  if (isStream(answer)) { const failed = blocks(answer.text).find(b => b.event === 'error' && b.data); return failed && decode(failed.data); }
  return answer.status >= 400 && answer.text ? decode(answer.text) : undefined;
};
/** oRPC codes that mean the server refused before acting (the client's contract). */
const REFUSED = ['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'PRECONDITION_FAILED', 'UNPROCESSABLE_CONTENT', 'TOO_MANY_REQUESTS'];
const json = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v);

/**
 * M4 runtime conformance: the published `ownerClient` on the real stack, through the signed-in owner's page, so every
 * request carries the real session. Each result must equal the raw wire answer it was built from:
 * - ok: the value (or each stream event) deep-equals the decoded body;
 * - a typed error (4xx body or a stream's `event: error`): the same kind and code;
 * - an untyped error: refusal codes are `refused`, anything else `unknown` (mutation) or `unavailable` (read);
 * - no answer: `unknown`/`unavailable`; a stream failing after its first event: `unknown` by contract.
 * `report` writes per-procedure outcomes (success, input refusal, handler refusal, denied, lost, each by scenario) and
 * requires every listed procedure to have answered. Scope: the platform source's `ownerClient`, not each app's packed
 * client (those run in the apps' own UI journeys and `pnpm contract:skills`).
 */
export function clientConformance(page, base, listed) {
  const coverage = Object.fromEntries(listed.map(p => [p, []])), failures = [], accepted = {}, outages = [];
  let lastRaw;
  const fetch = async (url, init) => {
    const answer = await page.evaluate(async ({ path, method, headers, body }) => {
      const response = await fetch(path, { method, headers, body });
      return { status: response.status, headers: [...response.headers], text: await response.text() };
    }, { path: new URL(url).pathname, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ?? undefined });
    lastRaw = answer;
    // An empty body stays null: `new Response('')` would add a text/plain content type the server never sent.
    return new Response(answer.text === '' ? null : answer.text, { status: answer.status, headers: answer.headers });
  };
  const client = ownerClient({ base, fetch });
  let scenario = 'normal';
  /** One call; `kind` (optional) is the outcome this input must produce. Returns the client's result. */
  async function check(procedure, input, kind) {
    lastRaw = undefined;
    let result;
    if (ownerStreams.includes(procedure)) {
      const values = [], run = client.stream(procedure, input);
      let next = await run.next();
      while (!next.done) { values.push(next.value); next = await run.next(); }
      result = next.value ?? { ok: true, value: values };
      if (result.ok && lastRaw) expect(values, `${procedure} events`).toEqual(events(lastRaw.text));
    } else {
      result = await client.call(procedure, input);
      if (result.ok) expect(result.value, `${procedure} value`).toEqual(lastRaw && !isStream(lastRaw) ? decode(lastRaw.text) : undefined);
    }
    const raw = lastRaw && rawError(lastRaw), denied = !result.ok && ['session', 'forbidden'].includes(result.kind);
    if (!result.ok && !denied) {
      if (raw?.data?.kind && !(isStream(lastRaw) && events(lastRaw.text).length)) {
        expect(result.kind, `${procedure} kind`).toBe(raw.data.kind);
        expect(result.code, `${procedure} code`).toBe(raw.data.code);
      } else if (raw && !raw.data?.kind) expect(result.kind, `${procedure} untyped ${raw.code}`).toBe(REFUSED.includes(raw.code) ? 'refused' : READS.has(procedure) ? 'unavailable' : 'unknown');
      else if (!raw && lastRaw) expect(result.kind, `${procedure} lost answer`).toBe(READS.has(procedure) ? 'unavailable' : 'unknown');
      failures.push({ procedure, kind: result.kind, raw: raw?.data?.kind ?? (lastRaw ? `${lastRaw.status} ${lastRaw.text.slice(0, 160)}` : 'no answer') });
    }
    const outcome = result.ok ? 'success' : denied ? 'denied' : ['unknown', 'unavailable'].includes(result.kind) ? 'lost'
      // oRPC input validation answers an untyped BAD_REQUEST: the handler never ran.
      : raw && !raw.data?.kind && raw.code === 'BAD_REQUEST' ? 'input refusal' : 'handler refusal';
    coverage[procedure]?.push({ scenario, outcome, kind: result.ok ? 'ok' : result.kind });
    if (result.ok) accepted[procedure] = input;
    if (kind) expect(result.ok ? 'ok' : result.kind, `${procedure} outcome: ${json(result).slice(0, 300)} raw: ${json(lastRaw)?.slice(0, 400)}`).toBe(kind);
    return result;
  }
  /**
   * Provider outage. Every listed procedure is either a case or excluded with a reason. A case repeats a valid input:
   * `inputs[procedure]` (built before the outage) or the last input it accepted. It counts as a reached fault only if
   * the provider refused at least one of its requests (`outageRefusals` grew); otherwise it must succeed locally, or be
   * refused as `unresolved` after an earlier case left an unknown outcome (the fail-safe: no send after an unknown).
   * Any other refusal before the provider is a failure: it would stand in for the fault without exercising it.
   */
  async function outage(provider, procedures, { inputs = {}, excluded = {} } = {}) {
    expect(Object.keys(excluded).filter(p => !procedures.includes(p)), 'exclusions name listed procedures').toEqual([]);
    scenario = 'provider outage';
    const reached = [], local = [], blocked = [], problems = [];
    provider.setUnavailable(true);
    try {
      for (const procedure of procedures.filter(p => !(p in excluded))) {
        const input = procedure in inputs ? inputs[procedure] : accepted[procedure];
        if (!(procedure in inputs) && !(procedure in accepted)) { problems.push(`${procedure}: no valid input (neither built for the outage nor accepted earlier)`); continue; }
        const before = provider.outageRefusals(), result = await check(procedure, input);
        if (provider.outageRefusals() > before) reached.push({ procedure, kind: result.ok ? 'ok' : result.kind });
        else if (result.ok) local.push(procedure);
        else if (result.kind === 'unresolved' && reached.some(r => r.kind === 'unknown')) blocked.push(procedure);
        else problems.push(`${procedure}: ${result.kind} before reaching the provider: ${json(result).slice(0, 160)}`);
      }
    } finally { provider.setUnavailable(false); scenario = 'normal'; }
    expect(problems, 'every outage case has a valid input and either reaches the provider, succeeds locally or is blocked by an earlier unknown').toEqual([]);
    expect(reached.length, 'the outage reached the provider').toBeGreaterThan(0);
    for (const [procedure, reason] of Object.entries(excluded)) coverage[procedure]?.push({ scenario: 'provider outage', outcome: 'excluded', reason });
    outages.push({ reached, local, blocked, excluded });
    return { reached, local, blocked };
  }
  return {
    client, check, outage,
    /** The last input each procedure accepted, to repeat it under a fault. */
    accepted,
    report(path) {
      writeFileSync(path, JSON.stringify({ scope: 'platform source ownerClient', coverage, failures, outages }, null, 2));
      expect(listed.filter(p => coverage[p].length === 0), 'every listed procedure answered through ownerClient').toEqual([]);
    },
  };
}
