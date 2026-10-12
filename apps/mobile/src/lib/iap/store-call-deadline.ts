/**
 * A store call must answer inside this window or the pass gives up.
 *
 * StoreKit and Play Billing both answer slowly on a cold connection, and a call
 * that never answers is worse than one that fails: the pass holds its in-flight
 * guard, so recovery is dead for the rest of the process and silent about it.
 * Measured on a simulator on 2026-09-29: the pass entered with 14 known product
 * ids, then `initConnection` never settled — no result, no failure, no further
 * recovery for the life of that app process.
 */
const STORE_CALL_DEADLINE_MS = 15_000;

/**
 * The store did not answer inside the deadline. Distinct from a store that
 * answered with a failure: a hung SDK stays hung for every further call, so a
 * caller must not follow a deadline with more calls to the same store (the
 * credit-product loader would otherwise spend another deadline per product id).
 * Carries only the label; the message never reaches the screen.
 */
class StoreDeadlineError extends Error {
  constructor(label: string) {
    super(`${label} did not answer within ${STORE_CALL_DEADLINE_MS} ms`);
    this.name = 'StoreDeadlineError';
  }
}

/**
 * Bounds a store call so a hung SDK never holds a recovery pass open.
 *
 * The underlying call keeps running — the store SDK has no cancellation — but
 * the race settles on the deadline and a late answer is ignored, so the caller
 * can release its in-flight guard and the next attempt may retry.
 */
export async function withStoreDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  const { promise: deadline, reject: failDeadline } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    failDeadline(new StoreDeadlineError(label));
  }, STORE_CALL_DEADLINE_MS);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
