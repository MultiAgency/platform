import { ASSETS } from "./assets.js";

const STORAGE_DEPOSIT = "1250000000000000000000"; // 0.00125 NEAR: one NEP-145 registration
const GAS = "30000000000000";
const call = (methodName: string, args: object, deposit: string) => ({
  type: "FunctionCall" as const,
  params: { methodName, args, gas: GAS, deposit },
});
const contractOf = (asset: string) => asset.replace(/^nep141:/, "");

/**
 * The owner's one-time registration of a market agent's payment key on USDC (docs/market.md): a USDC withdrawal to an
 * unregistered account fails, and the provider's withdrawal can't pay for registration. Either signer sends it.
 */
export const registrationTransaction = (account: string) =>
  ({ receiverId: contractOf(ASSETS.USDC), actions: [call("storage_deposit", { account_id: account, registration_only: true }, STORAGE_DEPOSIT)] });

/**
 * One transaction that pays `amount` (raw units) into an agent deposit address, ready for either signer: a NEAR
 * account's wallet sends it, a DAO files the same calls as one proposal. Deposit addresses start unregistered on the
 * token, so the transfer registers them first; NEAR is wrapped. With `deposit` (an app's `treasury` or `payout` scope)
 * it builds what the owner session's `treasury/fund` answers.
 */
export function fundingTransaction(asset: "USDC" | "NEAR", address: string, amount: string) {
  const register = call("storage_deposit", { account_id: address, registration_only: true }, STORAGE_DEPOSIT);
  const transfer = call("ft_transfer", { receiver_id: address, amount }, "1");
  return asset === "USDC"
    ? { receiverId: contractOf(ASSETS.USDC), actions: [register, transfer] }
    : { receiverId: contractOf(ASSETS.wNEAR), actions: [register, call("near_deposit", {}, amount), transfer] };
}
