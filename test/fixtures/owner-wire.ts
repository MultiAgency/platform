import { RPCJsonSerializer } from "@orpc/client";
import { RPCHandler } from "@orpc/server/fetch";
import { ownerClient, type OwnerProcedure } from "../../src/contract/owner-client.js";
import { router } from "../../src/router.js";

const serializer = new RPCJsonSerializer();
const decode = (text: string) => text === "" ? undefined : serializer.deserializeJson(JSON.parse(text));
/** One value per SSE message (a `data:` block without an event name, or `event: message`). */
const events = (text: string) => text.split("\n\n").flatMap(block => {
  const event = block.match(/^event: (.+)$/m)?.[1] ?? "message", data = block.match(/^data: (.*)$/m)?.[1];
  return event === "message" && data ? [decode(data)] : [];
});

/**
 * The real router behind an in-process oRPC handler, reached through the published `ownerClient`.
 * Every raw wire answer is kept (decoded with oRPC's serializer), so a test can require the client's value to
 * deep-equal what the handler actually sent.
 */
export function ownerWire(actor = "owner.near") {
  const handler = new RPCHandler(router);
  const raw: { procedure: OwnerProcedure; status: number; values: unknown[] }[] = [], pending: Promise<void>[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const procedure = new URL(request.url).pathname.replace(/^\/a\/fixture\/rpc\//, "") as OwnerProcedure;
    const { response } = await handler.handle(request, { prefix: "/a/fixture/rpc", context: { actor } });
    if (!response) return new Response("", { status: 404 });
    const copy = response.clone();
    const record = { procedure, status: response.status, values: [] as unknown[] };
    raw.push(record);
    const stream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    // Streams are read in full from the copy while the client reads its own.
    pending.push(copy.text().then(text => { record.values = stream ? events(text) : [decode(text)]; }));
    return response;
  };
  return { client: ownerClient({ base: "/a/fixture", fetch }), raw, settled: () => Promise.all(pending),
    last: (procedure: OwnerProcedure) => raw.filter(r => r.procedure === procedure).at(-1) };
}
