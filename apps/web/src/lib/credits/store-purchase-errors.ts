/**
 * Typed outcomes of the one-off credit-pack purchase flow.
 *
 * The completion router decides terminal versus retryable from these types and
 * never from error text. Matching message substrings made a transient database
 * error whose SQL happens to name `credit_transactions` look like a refused
 * receipt: the mobile client records a terminal refusal for the rest of the
 * process and stops recovering a purchase the user has already paid for, so a
 * database blip could strand a real charge. A store refusal is the only thing
 * that may be terminal here; database and provider failures stay retryable
 * because the grant is idempotent.
 */

/**
 * A receipt the store will never let succeed: a revoked or wrong-bundle Apple
 * transaction, a Play purchase that is not in a purchased state, a product that
 * is not a credit pack, a quantity Kilo cannot refund correctly. Replaying it
 * cannot change the answer.
 */
export class StoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreVerificationError';
  }
}

/**
 * The store transaction is already credited to a different Kilo account, so
 * the caller that presented it can never complete it.
 */
export class StoreCreditPurchaseOwnedByAnotherAccountError extends Error {
  constructor(message = 'Store transaction already belongs to another user') {
    super(message);
    this.name = 'StoreCreditPurchaseOwnedByAnotherAccountError';
  }
}
