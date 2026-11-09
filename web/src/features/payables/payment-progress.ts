import { isMoving } from "./payment-status.js";

/** Owner intent evidence and provider payment outcomes are independent observations. */
export function paymentProgress({ status, statusError, ownerError, approved, rejected, recovering }: {
  status?: string; statusError: boolean; ownerError: boolean; approved: boolean; rejected: boolean; recovering?: string;
}) {
  return {
    owner: ownerError ? "Owner decision unavailable" : approved ? "Approval recorded" : rejected ? "Rejection recorded"
      : recovering ? `Owner action ${recovering}` : "No owner decision confirmed",
    outcome: statusError ? "Status unavailable" : status === "SUCCESS" ? "Paid" : status === "PENDING_APPROVAL" ? "Held for approval"
      : isMoving(status) ? "Payment processing" : status === "FAILED" || status === "REFUNDED" ? `Provider reported ${status.toLowerCase()}`
      : status ? "Outcome unresolved" : "Reading payment status…",
  };
}
