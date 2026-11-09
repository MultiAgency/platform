import { createTdxQuoteVerifier, InferenceClient, type TcbStatus } from "@nearai/inference-sdk/node";
import OpenAI from "openai";

/**
 * Verified inference on NEAR AI Cloud, inside a TEE: requests and responses are end-to-end encrypted to the attested
 * model, and callers check every response's signature (`inference.verifyResponse`). The Payables guide uses it.
 */

const BASE_URL = "https://cloud-api.near.ai/v1";
export const MODEL = "z-ai/glm-5.3-flash";

/**
 * Attestation policy for every model call; anything outside it fails before a request is sent.
 *
 * The model must be `UpToDate` and present GPU evidence: requests are encrypted to its attested
 * key and its signature is checked on every response, so it carries confidentiality and integrity.
 * The gateway, which relays that ciphertext, may also be `OutOfDate`, but only with exactly the
 * Intel advisories reviewed here (its status on 2026-10-10). A new advisory, a worse status, or any
 * change on the model side fails closed. (The SDK's default accepts `OutOfDate` with any advisory.)
 */
export const ATTESTATION = {
  modelTcb: ["UpToDate"] as readonly TcbStatus[],
  gatewayTcb: ["UpToDate", "OutOfDate"] as readonly TcbStatus[],
  gatewayAdvisories: ["INTEL-SA-01192", "INTEL-SA-01245", "INTEL-SA-01312", "INTEL-SA-01313"] as readonly string[],
};

export function verifiedInference(apiKey: string, policy = ATTESTATION) {
  const quote = createTdxQuoteVerifier();
  const inference = new InferenceClient({
    apiKey,
    baseUrl: BASE_URL,
    e2ee: true,
    gatewayVerification: {
      policy: { acceptedTcbStatuses: policy.gatewayTcb },
      verifiers: {
        // The SDK's quote check, plus the advisory pin it doesn't offer.
        tdxQuote: async (evidence) => {
          const result = await quote(evidence);
          const unreviewed = result.advisoryIds.filter((id) => !policy.gatewayAdvisories.includes(id));
          if (result.tcbStatus !== "UpToDate" && unreviewed.length > 0)
            throw new Error(`Gateway TCB ${result.tcbStatus} with unreviewed advisories ${unreviewed.join(", ")}`);
          return result;
        },
      },
    },
    modelVerification: { policy: { acceptedTcbStatuses: policy.modelTcb, gpuEvidence: "required" } },
  });
  // A turn that hangs fails fast and is retried (twice, by the SDK) rather than stalling the loop.
  const llm = new OpenAI({ apiKey, baseURL: BASE_URL, fetch: inference.fetch, timeout: 120_000 });
  return { inference, llm };
}
