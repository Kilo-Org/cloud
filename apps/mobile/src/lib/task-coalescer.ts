/**
 * Runs one correction per task, however many events ask for it.
 *
 * A keyboard slide reports several layout passes, and the composer beside the
 * transcript changes the content height in the same task. Correcting each of
 * those events hard-scrolls the list several times in one task, so the content
 * moves in alternating jumps instead of following the keyboard.
 */
export type TaskCoalescer = {
  /** Drops the queued correction. A caller that unmounts must use it. */
  cancel: () => void;
  /** True when a correction is already queued for this task. */
  isPending: () => boolean;
  /** Queues `run` unless a correction is already queued for this task. */
  schedule: (run: () => void) => void;
};

export function createTaskCoalescer(): TaskCoalescer {
  let pending = false;
  // A queued microtask cannot be withdrawn, so it checks the generation that
  // was current when it was queued and does nothing after a cancel.
  let generation = 0;
  return {
    cancel: () => {
      pending = false;
      generation += 1;
    },
    isPending: () => pending,
    schedule: run => {
      if (pending) {
        return;
      }
      pending = true;
      const scheduled = generation;
      queueMicrotask(() => {
        if (scheduled !== generation) {
          return;
        }
        pending = false;
        run();
      });
    },
  };
}
