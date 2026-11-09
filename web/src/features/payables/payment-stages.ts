export type PaymentStage = "complete" | "current" | "upcoming" | "stopped" | "unverified";

const ENDED_UNAPPROVED = new Set(["Rejected", "Removed", "Expired"]);

/** Each stage requires its own evidence; settlement never reconstructs an owner decision. */
export function paymentStages({ heldEvidence, proposal, approved, rejected, recovering, paid, failed, s, isHeld }: { heldEvidence: boolean; proposal?: { status: string }; approved: boolean; rejected: boolean; recovering?: { stage: string }; paid: boolean; failed: boolean; s?: string; isHeld: boolean }) {
  const step = (index: number): PaymentStage => {
    if (index === 1) return heldEvidence ? "complete" : "unverified";
    // Rejected, Removed and Expired end a Sputnik proposal unapproved; Failed can be finalized again, and any other status isn't known to end it.
    if (index === 2) return proposal ? (proposal.status === "Approved" ? "complete" : ENDED_UNAPPROVED.has(proposal.status) ? "stopped" : "current")
      : approved || rejected ? "complete" : "unverified";
    if (index === 3) return rejected ? "stopped" : approved ? "complete" : recovering?.stage === "submitted" ? "current" : "unverified";
    return paid ? "complete" : failed ? "stopped" : s && !isHeld ? "current" : "upcoming";
  };
  return step;
}
