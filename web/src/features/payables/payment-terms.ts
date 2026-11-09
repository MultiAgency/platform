type Terms = { maxAmount: string; until: string };

/**
 * The terms a voter checks a held payout against: the payee's newest agreement with terms that isn't declined, as
 * src/agreements.ts `termsFor` picks them. `agreements` is `agreements/list`'s answer, newest first.
 */
export const termsInForce = <A extends { payee: string; status: string; terms?: Terms }>(agreements: readonly A[], payee: string) =>
  agreements.find((a) => a.payee === payee && a.terms && a.status !== "declined")?.terms;
