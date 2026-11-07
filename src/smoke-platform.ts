/**
 * Read-only checks of a platform host (`headless`: app access and the confirm page only), as an outsider sees it:
 * every request is unauthenticated and changes nothing. The confirm page is checked with every script and stylesheet
 * it loads, since a host without its build's manifest serves the page blank with no error.
 *
 * A request for another host can't be checked through a hosting edge (it answers for unattached hosts itself), so the
 * gateway's 421 stays offline-tested (`test/platform-host.test.ts`).
 */
export type Check = { name: string; ok: boolean; detail: string };

/** A link token no confirmation has: the page itself is served for any well-formed token, and reads nothing. */
const UNUSED_LINK = "smoke00000000000000000";
const ELSEWHERE = "https://elsewhere.example";

export async function platformChecks(base: URL, fetcher: typeof fetch = fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const at = (path: string) => new URL(path, base);
  const get = (path: string, headers: Record<string, string> = {}) => fetcher(at(path), { headers, redirect: "manual" });
  const status = async (path: string, init: RequestInit = {}) => (await fetcher(at(path), { redirect: "manual", ...init })).status;

  const health = await get("/health");
  check("platform /health", health.ok && ((await health.json().catch(() => null)) as { ok?: boolean } | null)?.ok === true, String(health.status));

  // App access needs a credential, and refuses a browser.
  const agent = await status("/apps/v1/agents/smoke");
  check("app access needs a credential", agent === 401, String(agent));
  const browser = await status("/apps/v1/agents/smoke", { headers: { origin: ELSEWHERE } });
  check("app access refuses a browser", browser === 403, String(browser));
  const daoConsent = await status("/apps/v1/dao-consents", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("DAO consents need a credential", daoConsent === 401, String(daoConsent));

  // Nothing of the prototype's gateway: no owner app, sign-in or owner routes.
  for (const path of ["/", "/gw/challenge", "/a/x/access", "/build-manifest.json"]) {
    const answer = await status(path);
    check(`platform serves no ${path}`, answer === 404, String(answer));
  }

  // The confirm page and everything it loads.
  const page = await get(`/confirm/${UNUSED_LINK}`);
  const html = page.ok ? await page.text() : "";
  check("confirm page", page.ok && /<html/i.test(html), String(page.status));
  const assets = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="(\/static\/[^"]+\.(?:js|css))"/g)].map(match => match[1]!);
  check("confirm page loads its scripts", assets.some(path => path.endsWith(".js")), assets.length ? assets.join(", ") : "no script or stylesheet in the page");
  for (const path of assets) {
    const answer = await status(path);
    check(`confirm asset ${path}`, answer === 200, String(answer));
  }

  // A DAO stop page for no request: a page of the host's own, with no script, under a closed policy.
  const stop = await get("/confirm/dao/stop/smoke.sputnik-dao.near/smoke");
  const stopPage = await stop.text();
  check("unknown DAO stop page is 404", stop.status === 404, String(stop.status));
  check("unknown DAO stop page runs no script", !/<script/i.test(stopPage) && /default-src 'none'/.test(stop.headers.get("content-security-policy") ?? ""),
    stop.headers.get("content-security-policy") ?? "no content-security-policy");
  return checks;
}
