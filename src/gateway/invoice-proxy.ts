import { request } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";

/** A single streaming submission to the existing executor. No redirect following and no retries. */
export function forwardInvoice(req: IncomingMessage, res: ServerResponse, origin: string, path: string, transport: typeof request = request, cookieName = "invoices_session", timeoutMs = 15 * 60_000) {
  const target = new URL(origin);
  const headers: IncomingMessage["headers"] = { ...req.headers, host: target.host };
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-for"];
  delete headers["forwarded"];
  // Gateway headers are set only by the gateway itself, never passed through from a client.
  for (const name of Object.keys(headers)) if (name.startsWith("x-gateway")) delete headers[name];
  for (const name of (req.headers.connection ?? "").split(",").map(s => s.trim().toLowerCase())) delete headers[name];
  for (const name of ["connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]) delete headers[name];
  headers.host = target.host;
  // Dashboard sessions never reach intake; its payee session remains independent.
  const cookie = req.headers.cookie?.split(";").map(c => c.trim()).filter(c => c.startsWith(`${cookieName}=`)).join("; ");
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  const upstream = transport(target, { method: req.method, path, headers }, answer => {
    if ((answer.statusCode ?? 500) >= 300 && (answer.statusCode ?? 500) < 400) {
      answer.resume();
      return sendJson(res, 502, { error: "Invoice backend redirected; check the original record before retrying." });
    }
    res.writeHead(answer.statusCode ?? 502, { ...answer.headers, "cache-control": "no-store" });
    answer.on("error", () => res.destroy());
    answer.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { error: "Invoice backend unavailable. A submitted request may have been accepted; check its original record before retrying." });
  });
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("Invoice backend timed out")));
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}
