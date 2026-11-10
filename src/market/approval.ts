/** A DAO's approval authorizes new submissions only before its deadline; attempted payments keep their own outcome. */
export const approvalExpired = (expiresAt: number | undefined, now = Date.now()) =>
  expiresAt !== undefined && (!Number.isFinite(expiresAt) || now >= expiresAt);
