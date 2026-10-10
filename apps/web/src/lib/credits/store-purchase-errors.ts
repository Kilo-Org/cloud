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
 * transaction, a canceled (or unknown-state) Play purchase, a product that is
 * not a credit pack, a quantity Kilo cannot refund correctly. Replaying it
 * cannot change the answer.
 */
export class StoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreVerificationError';
  }
}

/**
 * The backend contract string for a Play purchase the store has accepted but not
 * finished (`purchaseState` 2, e.g. a cash payment awaiting approval). Nothing is
 * wrong with the receipt: the same token becomes purchased (`purchaseState` 0)
 * once the store completes the charge, so the client must keep it queued instead
 * of forgetting it. The mobile error mapping matches this exact message.
 */
export const STORE_PURCHASE_PENDING_MESSAGE = 'This Google Play purchase is still pending.';

/**
 * A purchase that is not done yet, and not wrong: Play reports `purchaseState`
 * 2 (pending) while it finishes the charge. Unlike `StoreVerificationError` this
 * is retryable — the very same token is expected to verify once Play reports
 * state 0 — so the completion router must not answer with the terminal receipt
 * refusal, which the mobile client would remember for the rest of the process
 * and never recover the later-approved purchase.
 */
export class StorePurchasePendingError extends Error {
  constructor(message = STORE_PURCHASE_PENDING_MESSAGE) {
    super(message);
    this.name = 'StorePurchasePendingError';
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
