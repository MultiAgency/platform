const HOUR = 3_600_000;
/** Each other Organization seen this hour keeps this share of the credential's hourly limit available to it. */
export const SLICE = 0.05;
/** The slices kept back never exceed this share of the limit, however many Organizations are seen. */
export const MAX_KEPT = 0.5;

export type Decision = { allowed: true } | { allowed: false; reason: "limit" | "fair_share"; retryAfterSeconds: number };

/**
 * A credential's hourly budget, shared by every Organization its app serves (#59). No Organization is capped while others
 * don't need the budget: one tenant alone may use all of it. Each other Organization seen in the hour, even one refused,
 * keeps a slice available (`SLICE` of the limit, until it has used that much), and a request is refused if serving it
 * would eat into what is still owed to the others (at most `MAX_KEPT` of the limit). A refused newcomer is seen, so its
 * slice is kept from then on. Calls naming no Organization count toward the hour and have no slice.
 */
export function fairShare() {
  type Credential = { hits: number[]; byOrg: Map<string, number[]>; seen: Map<string, number> };
  const credentials = new Map<string, Credential>();
  const live = (times: number[], now: number) => times.filter(t => now - t < HOUR);

  function state(id: string, now: number): Credential {
    if (credentials.size > 10_000) for (const [k, c] of credentials) if (now - (c.hits.at(-1) ?? 0) >= HOUR) credentials.delete(k);
    const c = credentials.get(id) ?? { hits: [], byOrg: new Map(), seen: new Map() };
    credentials.set(id, c);
    c.hits = live(c.hits, now);
    for (const [org, times] of c.byOrg) { const kept = live(times, now); if (kept.length) c.byOrg.set(org, kept); else c.byOrg.delete(org); }
    for (const [org, at] of c.seen) if (now - at >= HOUR) c.seen.delete(org);
    return c;
  }

  function allow(id: string, org: string | null, now: number, limit: number): Decision {
    const c = state(id, now);
    if (org !== null && (c.seen.has(org) || c.seen.size < 10_000)) c.seen.set(org, now);
    const retryAfterSeconds = Math.max(1, Math.ceil(((c.hits[0] ?? now) + HOUR - now) / 1000));
    if (c.hits.length >= limit) return { allowed: false, reason: "limit", retryAfterSeconds };
    const slice = Math.ceil(limit * SLICE), used = (o: string) => c.byOrg.get(o)?.length ?? 0;
    if (org === null || used(org) >= slice) {
      let owed = 0;
      for (const other of c.seen.keys()) if (other !== org) owed += Math.max(0, slice - used(other));
      owed = Math.min(owed, Math.floor(limit * MAX_KEPT));
      if (c.hits.length + 1 + owed > limit) return { allowed: false, reason: "fair_share", retryAfterSeconds };
    }
    c.hits.push(now);
    if (org !== null) c.byOrg.set(org, [...(c.byOrg.get(org) ?? []), now]);
    return { allowed: true };
  }
  return { allow };
}
