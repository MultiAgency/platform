import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { sendJson as json } from "../http.js";
import type { AgentEntry } from "./config.js";

export const RPC_IDLE_TIMEOUT_MS = 15 * 60_000;

/** Most a held (inspected) reply may be; an owner intent with its preview is far smaller. */
const MAX_HELD_REPLY = 1 << 20;

/**
 * Forwards a call to an agent server on loopback, streaming both ways (some procedures stream events). With `hold`, a
 * successful reply is read whole and released only when `hold` returns null; a string refuses it (403 with that reason),
 * and `{ answer }` sends that JSON in its place.
 */
export function forwardRpc(req: IncomingMessage, res: ServerResponse, agent: AgentEntry, path: string, timeoutMs = RPC_IDLE_TIMEOUT_MS, body?: string, actor?: string,
  hold?: (reply: unknown) => string | null | { answer: unknown }) {
  const headers: import("node:http").OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${agent.port}` };
  delete headers.origin;
  delete headers.cookie;
  delete headers.authorization;
  for (const key of Object.keys(headers)) if (key.startsWith("x-gateway")) delete headers[key];
  if (actor) headers["x-gateway-actor"] = actor;
  if (body !== undefined) {
    delete headers["transfer-encoding"];
    headers["content-length"] = String(Buffer.byteLength(body));
    headers["content-type"] = "application/json";
  }
  const upstream = request({ host: "127.0.0.1", port: agent.port, path: `/rpc/${path}`, method: req.method, headers }, (answer) => {
    if ((answer.statusCode ?? 500) >= 300 && (answer.statusCode ?? 500) < 400) {
      answer.resume();
      return json(res, 502, { error: "Agent backend redirected. Check the original record before retrying." });
    }
    answer.on("error", () => res.destroy());
    const status = answer.statusCode ?? 502;
    if (!hold || status < 200 || status >= 300) {
      res.writeHead(status, { ...answer.headers, "cache-control": "private, no-store" });
      return answer.pipe(res);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    answer.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_HELD_REPLY) chunks.push(chunk);
    });
    answer.on("end", () => {
      const raw = Buffer.concat(chunks);
      let reply: unknown;
      try { reply = size <= MAX_HELD_REPLY ? JSON.parse(raw.toString("utf8")) : undefined; } catch { reply = undefined; }
      if (reply === undefined) return json(res, 502, { error: "Agent backend reply couldn't be checked. Check the original record before retrying." });
      let held: ReturnType<typeof hold>;
      // A hold that fails (a state write, a disk error) answers this call only; the reply is never released.
      try { held = hold(reply); }
      catch (error) {
        console.error("Holding an agent reply failed", error);
        return json(res, 502, { error: "The platform couldn't hold this reply. Nothing was released; prepare it again." });
      }
      if (typeof held === "string") return json(res, 403, { error: held });
      if (held) return json(res, status, held.answer, { "cache-control": "private, no-store" });
      const { "transfer-encoding": _chunked, ...headers } = answer.headers;
      res.writeHead(status, { ...headers, "content-length": raw.length, "cache-control": "private, no-store" }).end(raw);
    });
  });
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else json(res, 502, { error: "Agent backend unavailable. A submitted request may have been accepted; check its original record before retrying." });
  });
  // Settlement may wait 180 seconds per leg, with several legs before a response.
  // Allow fifteen minutes of inactivity; longer work remains recoverable by its record.
  // Bound inactivity, not total stream duration. A timeout never establishes non-execution.
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("Agent backend timed out")));
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  if (body === undefined) req.pipe(upstream);
  else upstream.end(body);
}
