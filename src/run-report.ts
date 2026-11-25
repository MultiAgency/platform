import { readFileSync, writeFileSync } from "node:fs";
import { appClient } from "./contract/app-client.js";
import type { Tick } from "./evidence.js";
import { hostedRpc, required } from "./remote.js";
import type { Row } from "./ledger.js";
import { type Intervention, unattendedReport } from "./report.js";

/**
 * The unattended-run report: what the treasury agent's scheduler recorded tick by tick (src/evidence.ts), checked
 * against the API's execution history and the gateway's record of calls that could act on the agent. Reads only.
 *
 * On a platform host, as an app deployment under the owner's consent (`read` and `treasury` scopes), with the
 * deployment's credential in APP_CREDENTIAL_FILE (a file holding `tap_…`, never pasted anywhere):
 *
 *   PLATFORM_URL=https://… APP_CREDENTIAL_FILE=… ORGANIZATION=… AGENT=… SINCE=2026-…Z [UNTIL=…Z] [OUT=report.md] pnpm run-report
 *
 * On the retired prototype dashboard, run from source, as the signed-in account in REPORT_COOKIE_FILE (`dao_session=…`):
 *
 *   DASHBOARD_URL=https://… REPORT_COOKIE_FILE=… SINCE=2026-…Z [UNTIL=…Z] [OUT=report.md] pnpm run-report
 *
 * It reports operation only: days of ticks say nothing about atomic budgets, strict caps or savings.
 */

const SINCE = required("SINCE");
const UNTIL = process.env.UNTIL ?? new Date().toISOString();
type Records = { evidence: { ticks: Tick[]; corrupt: number[] }; ledger: Row[]; interventions: { calls: Intervention[]; corrupt: number[] } };

/** Every read must answer: a report built on a missing record would claim more than was checked. */
function answered<T>(what: string, result: { ok: true; value: T } | { ok: false; kind: string; status?: number; httpStatus?: number; error?: string }): T {
  if (result.ok) return result.value;
  throw new Error(`${what}: ${result.kind}${result.error ? ` (${result.error})` : ""}`);
}

async function fromPlatform(base: string): Promise<Records> {
  const app = appClient({ base: base as `https://${string}`, credential: readFileSync(required("APP_CREDENTIAL_FILE"), "utf8").trim() });
  const agent = app.agent(required("ORGANIZATION"), required("AGENT"));
  const [evidence, ledger, interventions] = await Promise.all([
    agent.call("autopilot/evidence", { since: SINCE }), agent.call("ledger"), agent.interventions(SINCE)]);
  return {
    evidence: answered("autopilot/evidence", evidence) as unknown as Records["evidence"],
    ledger: answered("ledger", ledger) as unknown as Row[],
    interventions: answered("interventions", interventions),
  };
}

async function fromDashboard(base: URL): Promise<Records> {
  const cookie = readFileSync(required("REPORT_COOKIE_FILE"), "utf8").trim();
  const rpc = <T>(path: string, input?: unknown) => hostedRpc<T>(base, cookie, "treasury", path, input);
  const [evidence, ledger, interventions] = await Promise.all([
    rpc<Records["evidence"]>("autopilot/evidence", { since: SINCE }),
    rpc<Row[]>("ledger"),
    fetch(new URL(`/gw/interventions?since=${encodeURIComponent(SINCE)}`, base), { headers: { cookie } }).then(async (res) => {
      if (!res.ok) throw new Error(`interventions: ${res.status} ${await res.text()}`);
      const record = (await res.json()) as Records["interventions"];
      // A gateway that answers a bare list skips unreadable lines, so it can't show there were no calls.
      if (!Array.isArray(record.corrupt)) throw new Error("interventions: this gateway doesn't count unreadable lines; deploy a build that does");
      return record;
    }),
  ]);
  return { evidence, ledger, interventions };
}

const records = process.env.PLATFORM_URL ? await fromPlatform(process.env.PLATFORM_URL) : await fromDashboard(new URL(required("DASHBOARD_URL")));
const report = unattendedReport({ since: SINCE, until: UNTIL, ...records });
if (process.env.OUT) writeFileSync(process.env.OUT, report);
process.stdout.write(report);
