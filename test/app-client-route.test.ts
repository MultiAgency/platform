import assert from "node:assert/strict";
import { test } from "node:test";
import { appClient } from "../src/contract/app-client.js";

const read = (response: () => Response) => appClient({ base: "https://platform.test", credential: "tap_test",
  fetch: async () => response() }).daoHires.state("a".repeat(64));

test("a DAO hire relay 502 keeps its validated gateway code without claiming a payment outcome", async () => {
  assert.deepEqual(await read(() => Response.json({ code: "agent_answer_unverified", error: "The agent's reply did not prove the hire state." }, { status: 502 })),
    { ok: false, kind: "unavailable", httpStatus: 502, code: "agent_answer_unverified" });
  assert.deepEqual(await read(() => Response.json({ code: "made_up", error: "Unknown proxy response." }, { status: 502 })),
    { ok: false, kind: "unavailable", httpStatus: 502 }, "an unknown code is not attributed to the gateway");
  assert.deepEqual(await read(() => Response.json({ code: "agent_answer_unverified" }, { status: 502 })),
    { ok: false, kind: "unavailable", httpStatus: 502 }, "a code without the gateway's error shape is not trusted");
  assert.deepEqual(await read(() => new Response("<html>bad gateway</html>", { status: 502 })),
    { ok: false, kind: "unavailable", httpStatus: 502 }, "an unreadable proxy answer carries no gateway code");
});
