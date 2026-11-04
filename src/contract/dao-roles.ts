import type { Access } from "./permissions.js";

/**
 * A Sputnik DAO's roles as the platform reads them, so an app gates its own members with the same rules the platform
 * uses for its owner session (`src/gateway/roles.ts`). Pure: the app reads the policy itself (the DAO's `get_policy`
 * view) and passes it in. Combine with `mayCall(access, path)` to decide which procedures a member may trigger.
 */
export type DaoPolicy = {
  /** Attached to every add_proposal, exactly (yoctoNEAR). */
  proposal_bond: string;
  roles: DaoRole[];
  default_vote_policy: { threshold: unknown };
};
/** A role's kind is `Everyone`, a named `Group`, or token holders with at least a `Member` balance. */
export type DaoRole = {
  name: string;
  kind: { Group: string[] } | { Member: string } | string;
  permissions: string[];
  vote_policy: Record<string, { threshold: unknown }>;
};

/** The accounts a role names: a Group lists them; Everyone and token-weighted Member roles name none. */
export const groupOf = (role: DaoRole) => (typeof role.kind === "object" && "Group" in role.kind ? role.kind.Group : []);

/**
 * Whether `permissions` grant `action` on `kind` proposals, as the DAO contract reads them:
 * `<kind>:<action>`, `<kind>:*`, `*:<action>` or `*:*` (sputnikdao2/src/policy.rs `can_execute_action`).
 */
export const permits = (permissions: string[], kind: string, action: string) =>
  permissions.some((p) => p === `${kind}:${action}` || p === `${kind}:*` || p === `*:${action}` || p === "*:*");

/**
 * An agent's configured owner: a DAO with its policy, or an account (`policy: null`) that holds its own keys. `signer` is
 * the account that signs as the agent's owner: the account itself, or for a DAO the account its MPC key controls.
 */
export type ConfiguredOwner = { account: string; policy: DaoPolicy | null; signer: string };

/**
 * What `account` may do with an agent of `owner`, or null when it may do nothing. A wallet owner is its own only member
 * and signs directly. A DAO's members are the accounts its Group roles name (Everyone's public rights admit no one);
 * their capabilities come from their roles' and Everyone's permissions, and never include signing for the DAO.
 */
export function accessOf(account: string, owner: ConfiguredOwner): Access | null {
  if (!owner.policy) {
    if (account !== owner.account) return null;
    // No proposals: the owner's own wallet signs.
    return { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true };
  }
  // Everyone's public proposal rights do not grant access to this private workspace.
  if (!owner.policy.roles.some((r) => groupOf(r).includes(account))) return null;
  const roles = owner.policy.roles.filter((r) => r.kind === "Everyone" || groupOf(r).includes(account));
  const permissions = roles.flatMap((r) => r.permissions);
  const canPropose = permits(permissions, "call", "AddProposal");
  const canVote = permits(permissions, "call", "VoteApprove");
  return {
    canSign: false,
    canPropose,
    canVote,
    // App controls derived from DAO permissions; they never replace owner signatures or grant checks.
    canExecute: canPropose && canVote,
    canManage: permits(permissions, "policy", "AddProposal") && permits(permissions, "policy", "VoteApprove"),
  };
}
