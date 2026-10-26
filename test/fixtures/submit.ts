// Child process for owner-intents.test.ts: submits the pending intent "grant", prepared before this
// process started, while the API answers as argv[2] says:
//   lost      the submission fails without an answer (a dropped connection)
//   refused   the API refuses the signature, a refusal no retry changes
//   accepted  the API accepts it and the grant comes into force
//   unreached the submission fails before the API receives it: the intent still awaits a signature
//   late      the API receives the signature only when it is sent again
//   forged    the wallet returns a signature that isn't the owner's over the prepared intent
// Prints how the submission ended.
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { readFileSync } from "node:fs";
import { api } from "../../src/api.js";
import { reconcileOwnerIntents, submit } from "../../src/owner-intents.js";
import { walletSignature } from "./wallet-signature.js";

const refusal = new AgentApiError(400, {
  errors: [{ status: "400", code: "invalid_signature", layer: "request", title: "Invalid signature", meta: { retryable: false } }],
  meta: {},
});
const answers = {
  lost: async () => {
    throw new TypeError("fetch failed");
  },
  refused: async () => {
    throw refusal;
  },
  accepted: async () => ({ correlation_id: "grant", status: "QUEUED" }),
  unreached: async () => {
    throw new TypeError("fetch failed");
  },
};
let sends = 0;
const creation = JSON.parse(readFileSync(".owner-intents/.env.json", "utf8")).grant.type === "agent_create";
Object.assign(api, {
  submitIntent: async () => {
    sends++;
    return (answers[process.argv[2] as keyof typeof answers] ?? answers.accepted)();
  },
  getStatus: async (correlation_id: string) => {
    if (process.argv[2] === "timeout") throw new Error("status timeout");
    if (process.argv[2] === "unreached" || (process.argv[2] === "late" && sends === 0)) return { correlation_id, status: "PENDING_SIGNATURE" };
    return { correlation_id, status: process.argv[2] === "uncertain" ? "UNCERTAIN" : "SUCCESS", agent_id: creation ? "recovered-agent" : process.env.AGENT_ID };
  },
});

try {
  const result = process.argv[2] === "recover" || process.argv[2] === "late"
    ? await reconcileOwnerIntents()
    : await submit("grant", process.argv[2] === "forged"
      ? { ...(await walletSignature()), signature: Buffer.alloc(64, 1).toString("base64") }
      : await walletSignature());
  console.log(JSON.stringify({ result, sends }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), sends }));
}
