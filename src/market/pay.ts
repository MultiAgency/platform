import { paidCall, message, type Task } from "./client.js";
import { paymentKey } from "./payment-key.js";
import { paymentHeader, paymentId, type X402Request } from "./x402.js";
import { contractOf } from "../chain.js";

/**
 * The x402 leg of `send` (src/agent.ts), the only caller. Signing is local and runs before the submission claim, so a
 * refusal here (a key that isn't the recorded payer) leaves nothing claimed. The paid call runs after the claim: from
 * then on its outcome is the chain's (src/market/resolution.ts), whatever the call answers.
 */

/** The `X-PAYMENT` header for a recorded payment. Ed25519 is deterministic: the same request always signs the same bytes. */
export async function signedPayment(request: X402Request): Promise<string> {
  const signer = paymentKey();
  if (signer.account !== request.payer || signer.publicKey !== request.publicKey)
    throw new Error("The payment key isn't the payer this payment recorded");
  if (contractOf(request.asset) !== request.row.asset || request.amount !== request.row.amount)
    throw new Error("The payment's asset or amount isn't its row's");
  const { signedDelegateAction } = await signer.sign({ asset: request.row.asset, payTo: request.row.payTo, amount: request.row.amount,
    nonce: BigInt(request.nonce), maxBlockHeight: BigInt(request.maxBlockHeight) });
  return paymentHeader(request.row, signedDelegateAction);
}

/** The market didn't take the paid call. Not a refusal: the header left this host, so only the chain can prove nothing moved. */
export class PaymentNotTaken extends Error {
  constructor(readonly httpStatus: number, readonly reason: string) { super(`The market didn't take the payment (HTTP ${httpStatus}): ${reason}`); }
}

/** A `502` means the facilitator was unreachable: the same header is sent again, never a new signature (skill 0.2.0). */
const ATTEMPTS = 3, RETRY_MS = 2_000;

/** The paid call. Its task, or `PaymentNotTaken`; a transport failure throws as it is. */
export async function paidHire(request: X402Request, header: string): Promise<{ correlation_id: string; task: Task }> {
  const params = message(request.messageId, request.brief);
  for (let attempt = 1; ; attempt++) {
    const answer = await paidCall(request.handle, params, header);
    if ("task" in answer) return { correlation_id: paymentId(request), task: answer.task };
    if (answer.status !== 502 || attempt === ATTEMPTS) throw new PaymentNotTaken(answer.status, answer.error);
    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
}
