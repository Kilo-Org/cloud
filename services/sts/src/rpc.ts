/** What the deadline settles with when the callee has not answered in time. */
const DEADLINE = Symbol('deadline');

export type DeadlineOutcome<T> =
  | { status: 'answered'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'deadline' };

/**
 * One Durable Object call, bounded by `deadlineMs`. A caller cannot cancel an RPC, and a Durable
 * Object waiting on one stays in memory, billed, until it completes, so STS stops waiting itself.
 * Its context then ends and workerd cancels the call on this side only: the object finishes its
 * own work.
 *
 * The answer is a plain copy, and the RPC result is disposed here. workerd gives every object an
 * RPC call returns a disposer, and a method that returns an object with a disposer keeps its own
 * context open until its caller disposes that object: STS would end only when the calling Worker
 * remembered to. https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/ A result
 * that lands after the deadline, while this context lives, is disposed too.
 */
export async function callWithDeadline<T extends object>(
  call: () => Promise<T>,
  deadlineMs: number
): Promise<DeadlineOutcome<T>> {
  // Partial: only a workerd RPC result carries a disposer, and only on its top-level object.
  // Created in an async callback, so a stub that throws as it is made becomes a rejection.
  const pending: Promise<T & Partial<Disposable>> = Promise.try(call);
  const deadline = Promise.withResolvers<typeof DEADLINE>();
  const timer = setTimeout(() => deadline.resolve(DEADLINE), deadlineMs);
  let result: (T & Partial<Disposable>) | typeof DEADLINE;
  try {
    result = await Promise.race([pending, deadline.promise]);
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    clearTimeout(timer);
  }
  if (result === DEADLINE) {
    // Once the context ends, workerd has cancelled the call, so no result arrives.
    void pending.then(
      late => late[Symbol.dispose]?.(),
      () => undefined
    );
    return { status: 'deadline' };
  }
  try {
    // The disposer is non-enumerable, so the spread leaves it behind; nested values are plain data.
    return { status: 'answered', value: { ...result } };
  } finally {
    result[Symbol.dispose]?.();
  }
}
