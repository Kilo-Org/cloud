/**
 * Coalesce many value updates into at most one publication per animation
 * frame. `push` stores the latest value and schedules exactly one flush per
 * frame; `flush` publishes a pending value immediately; `cancel` fully
 * disables the coalescer so no later `push` or `flush` publishes anything.
 *
 * The scheduler is injectable so tests can drive frames synchronously.
 */
export type FrameCoalescer<T> = {
  push: (value: T) => void;
  flush: () => void;
  cancel: () => void;
};

/**
 * Default scheduler: `requestAnimationFrame` where available (React Native),
 * falling back to a zero-delay timeout in environments without it (node
 * tests). The fallback preserves "publish eventually" so a coalescer never
 * silently drops a pushed value.
 */
const rafSchedule = (frame: () => void): void => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(frame);
    return;
  }
  setTimeout(frame, 0);
};

export function createFrameCoalescer<T>(
  publish: (value: T) => void,
  schedule: (cb: () => void) => void = rafSchedule
): FrameCoalescer<T> {
  let pending: T | undefined = undefined;
  let hasPending = false;
  // True while a flush is queued on the scheduler. Guards against scheduling
  // more than one flush per frame.
  let scheduled = false;
  // True after `cancel`. Once cancelled, the coalescer is fully disabled:
  // `push` stores nothing and `flush` publishes nothing.
  let cancelled = false;

  function flush(): void {
    if (cancelled || !hasPending) {
      return;
    }
    hasPending = false;
    const value = pending as T;
    pending = undefined;
    publish(value);
  }

  function push(value: T): void {
    if (cancelled) {
      return;
    }
    pending = value;
    hasPending = true;
    if (scheduled) {
      return;
    }
    scheduled = true;
    schedule(() => {
      scheduled = false;
      flush();
    });
  }

  function cancel(): void {
    cancelled = true;
    hasPending = false;
    pending = undefined;
  }

  return { push, flush, cancel };
}
