/**
 * A minimal synchronous submission lock.
 *
 * React state updates are batched and deferred to the next render, so two
 * synchronous `handleSend()` invocations in the same tick can both observe the
 * captured `canSend=true` and proceed. A ref-backed lock with synchronous
 * acquire/release semantics closes that window: the second call sees the lock
 * held and bails before any side effect, upload, parser, or callback runs.
 */
export type SubmitLock = {
  acquire(): boolean;
  release(): void;
  /**
   * Read-only state for synchronous guards that cannot safely mutate the lock
   * (e.g. ignoring a tap on a suggestion while a send is already in flight).
   */
  isLocked(): boolean;
};

export function createSubmitLock(): SubmitLock {
  let locked = false;
  return {
    acquire() {
      if (locked) {
        return false;
      }
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
    isLocked() {
      return locked;
    },
  };
}
