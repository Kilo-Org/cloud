/**
 * Runs an operation only after the previously enqueued one has settled
 * (resolved or rejected). `useAgentSessions` shares one coordinator between
 * the stored list's `fetchNextPage` and its `refetch`, so a next-page fetch
 * can never overlap a focus-return/pull-to-refresh/retry refetch on the same
 * infinite query, and vice versa. A rejected operation never wedges the
 * queue.
 */
type OperationCoordinator = <T>(operation: () => Promise<T>) => Promise<T>;

async function awaitSettled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Swallow — sequencing only; the caller observes the real outcome.
  }
}

export function createOperationCoordinator(): OperationCoordinator {
  let tail: Promise<unknown> | undefined = undefined;
  // eslint-disable-next-line typescript-eslint/require-await -- the await lives inside the nested IIFE so the tail is registered synchronously, before the next caller chains behind it (same pattern as chainSave)
  return async operation => {
    const previous = tail;
    const next = (async () => {
      if (previous) {
        await previous;
      }
      return operation();
    })();
    tail = awaitSettled(next);
    return next;
  };
}
