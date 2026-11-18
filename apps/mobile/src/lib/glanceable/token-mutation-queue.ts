/**
 * FIFO chain for the activity-token mutations: an upsert and a delete of a
 * stable token must never race. Split out of `delivery-registration` so that
 * module keeps room under the repo's max-lines limit — no behavior change.
 */

let mutationTail: Promise<void> | null = null;
const NOOP = (): void => undefined;

export async function enqueueTokenMutation<T>(op: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release: () => void = NOOP;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  mutationTail = gate;
  // The tail is a release gate, not the mutation promise; it always resolves.
  await previous;
  try {
    return await op();
  } finally {
    release();
  }
}

/** Test-only: drop a chain left behind by a previous case. */
export function resetTokenMutationQueue(): void {
  mutationTail = null;
}
