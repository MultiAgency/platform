import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RPCHandler } from "@orpc/server/node";
import { startAutopilot } from "./autopilot.js";
import { startNotifications } from "./notify.js";
import { startReconciliation } from "./recover.js";
import { router } from "./router.js";
import { executes, saveEnv } from "./env.js";
import { acquireExecutorLease } from "./executor-lease.js";
import { createExecutorLifecycle } from "./executor-lifecycle.js";
import { crossSite, serveStatic } from "./http.js";
import { resumeOwnerIntents, setAgentCreationHandler } from "./owner-intents.js";
import { closeWorkOrders, resumeWorkOrders } from "./work-order-pool.js";
import { listeningMessage } from "./gateway/agent-origin.js";
import { moneyIdle, stopSending } from "./lock.js";

const PORT = Number(process.env.PORT ?? 8787);

/** A gateway header (`x-gateway-*`): the gateway strips any a caller sent and sets its own. */
const header = (req: IncomingMessage, name: string) => typeof req.headers[name] === "string" ? req.headers[name] : undefined;

const handler = new RPCHandler(router);
if (process.env.INVOICES_PORT && !process.env.AGENT_ID) throw new Error("Configure the payout agent before enabling invoices");
// An approve-only instance (EXECUTOR=off) is not the agent's executor: no lease, and no invoice page, which sends.
if (!executes() && process.env.INVOICES_PORT) throw new Error("EXECUTOR=off can't serve invoices: invoices send payouts");
const executor = createExecutorLifecycle({
  executes,
  acquire: acquireExecutorLease,
  configure: id => saveEnv({ AGENT_ID: id }),
  start: () => {
    try { startReconciliation(); startNotifications(); startAutopilot(); }
    catch (error) {
      console.error("Executor startup failed; stopping before accepting more work.", error);
      process.exit(1);
    }
  },
});
setAgentCreationHandler(id => executor.activate(id, true));
await executor.activate(process.env.AGENT_ID);
if (executes() && process.env.AGENT_ID) resumeWorkOrders(process.env.AGENT_ID);
const invoices = process.env.INVOICES_PORT ? (await import("./invoice-http.js")).startInvoiceServer() : undefined;

// This process holds the agent's grant: answer only same-origin requests on loopback.
const dashboard = createServer(async (req, res) => {
  // Nothing a request carries may end this process: it also runs the agent's money loops.
  try {
    await serveDashboard(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Treasury dashboard on http://localhost:${PORT}`);
  // The gateway that started this process reaches it only after this (src/gateway/agent-origin.ts).
  if (process.send) { process.send(listeningMessage(PORT)); process.channel?.unref(); }
  resumeOwnerIntents();
});

async function serveDashboard(req: IncomingMessage, res: ServerResponse) {
  // Loopback only, and only from this page: a malformed Origin (`null`, garbage) is refused like a foreign one.
  const payee = req.url?.startsWith("/supplier/") && process.env.HOSTED_INVOICE_BASE;
  const wrongOrigin = payee ? req.headers.origin !== undefined && req.headers.origin !== `https://${process.env.INVOICES_PUBLIC_HOST}` : crossSite(req);
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "") || wrongOrigin) {
    res.writeHead(403).end();
    return;
  }
  if (["/rpc/instance", "/rpc/autopilot/log", "/rpc/owner/actions", "/rpc/paymentHistory", "/rpc/strategy/get"].includes(req.url?.split("?")[0] ?? "")) res.setHeader("cache-control", "private, no-store");
  await executor.activate(process.env.AGENT_ID);
  // Hosted payee HTTP runs inside this same payout executor and its existing lease.
  // Import only after onboarding establishes the agent identity; never start another writer.
  if (req.url?.startsWith("/supplier/") && process.env.HOSTED_INVOICE_BASE) {
    if (!executes() || !process.env.AGENT_ID) {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: "The owner must finish agent setup before contributor intake is available." }));
      return;
    }
    req.url = req.url.slice("/supplier".length);
    return (await import("./invoice-http.js")).invoiceHandler(req, res);
  }
  const { matched } = await handler.handle(req, res, { prefix: "/rpc", context: { actor: header(req, "x-gateway-actor"), consent: header(req, "x-gateway-consent"), host: header(req, "x-gateway-host"),
    consents: header(req, "x-gateway-consents")?.split(",") } });
  if (matched) return;

  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) {
    res.writeHead(400).end();
    return;
  }
  await serveStatic(res, "web/dist", url.pathname, "Not found. Run `pnpm build:web` first, or use `pnpm web` in development.");
}

// A stop starts no send and lets the one in flight finish, within the gateway's 30-second grace for its agents: a send
// cut off mid-call would stay unresolved and block every later one until reviewed.
const SEND_GRACE_MS = 25_000;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  stopSending();
  dashboard.close(); invoices?.close();
  // The work-order executors drain at the same time, within the same grace, not after this process's send.
  const [idle] = await Promise.all([moneyIdle(SEND_GRACE_MS), closeWorkOrders()]);
  if (!idle) console.error(`A money action was still running after ${SEND_GRACE_MS / 1000} s; stopping anyway. Reconcile before relying on its outcome.`);
  await executor.close();
  process.exit(0);
});
