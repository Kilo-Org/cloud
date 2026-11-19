import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { deleteAccountMetadata, setAccountMetadata } from '@/lib/auth/account-metadata-write';
import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';

function noop(): void {
  // Placeholder until the promise executor hands over its resolve.
}

/**
 * Module-level store for a SecureStore-backed preference so every hook
 * instance (settings sheet, message list, new-session screen) shares one
 * value and one disk read. Consume via useSyncExternalStore.
 *
 * The rendered value is the durable one: `set()` records a target, one write at
 * a time carries the latest target to disk, and the value the app shows moves
 * only when its write lands. A burst of choices therefore writes at most the
 * in-flight value plus the newest one — never a queue of stale values — and the
 * app never shows a choice the disk does not hold.
 */
export function createSecureStorePreference<T>(options: {
  key: string;
  defaultValue: T;
  parse: (raw: string | null) => T;
  serialize: (value: T) => string;
  /**
   * Reconciles a pending in-memory write with the disk value that arrives
   * after it. Only runs when a set()/clear() happened before the initial
   * load resolved; `disk` is the parsed persisted value and `pending` is the
   * in-memory value at load time.
   */
  mergeOnLoad?: (disk: T, pending: T) => T;
}) {
  const { key, defaultValue, parse, serialize, mergeOnLoad } = options;
  let value = defaultValue;
  /**
   * The newest target whose write has not been persisted yet. A second choice
   * made while one write is in flight replaces it, so superseded choices are
   * never written and an older write can never land after a newer one.
   */
  let requested: T | undefined = undefined;
  /**
   * The target of the write currently on its way to disk. A read that derives
   * the next value (add to a list, flip a switch) must see it, or two changes in
   * one frame would both start from the value before the first one.
   */
  let inFlight: T | undefined = undefined;
  /**
   * The target of the persist-then-apply write while it is on disk's way.
   * `getRequested()` must keep seeing the last durable value while the write
   * runs, so a caller like the push-token locale registration is not told about
   * a language the write may still reject; `hasPendingWrite` and
   * `getPendingWriteTarget` read it.
   */
  let asyncWriteTarget: T | undefined = undefined;
  let writing = false;
  let hasLoaded = false;
  let loadSettled = false;
  // A set() or clear() before the initial load resolves must win over the
  // disk value.
  let dirty = false;
  // Whether the newest change was a clear() rather than a set(). A clear with
  // no choice after it must not merge the disk value back in even when
  // mergeOnLoad is set.
  let cleared = false;
  /**
   * The delete the latest clear() queued, and whether it landed. A read that
   * starts after a clear waits for this: until it lands the disk still holds
   * the snapshot the clear removed, and a read of that snapshot would bring the
   * cleared value back into memory and back onto disk.
   */
  let clearDeletion: Promise<boolean> | undefined = undefined;
  let loadStarted = false;
  /**
   * Bumped by clear(), and by the `mergeOnLoad` reconcile that repaints the
   * value. A write that started under an earlier epoch still lands (the delete
   * queued behind it wins), but it must not repaint a value the store has
   * already moved past: the cleared default, or the merged list its own target
   * is part of.
   */
  let writeEpoch = 0;
  /**
   * Bumped by clear() and by nothing else, so a persist-then-apply write can
   * tell a reset — which discards its choice — apart from a reconcile, which
   * only repaints the value.
   */
  let clearEpoch = 0;
  let markLoaded = noop;
  // Resolves once the disk read settles, so a caller with no React tree (the
  // Android widget task) can await the stored value instead of reading the
  // default.
  const loaded = new Promise<void>(resolve => {
    markLoaded = resolve;
  });
  // Callers that must observe durability (tests, the language apply) await the
  // queue draining instead of polling.
  let drainWaiters: (() => void)[] = [];
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  /**
   * The newest value the app has asked for: the queued target, the target being
   * written, or the durable value. Relative edits (a list add, a switch flip)
   * start from this so two changes in one frame both survive.
   *
   * `undefined` is the "nothing pending" marker, compared explicitly: a store
   * whose value is nullable (`string | null`, the voice-input language "auto")
   * must report a requested `null` instead of falling through to the old value.
   */
  const currentRequested = (): T => {
    if (requested !== undefined) {
      return requested;
    }
    if (inFlight !== undefined) {
      return inFlight;
    }
    return value;
  };

  const releaseDrainWaiters = () => {
    if (writing || requested !== undefined) {
      return;
    }
    const released = drainWaiters;
    drainWaiters = [];
    for (const release of released) {
      release();
    }
  };

  /** Applies a value the disk now holds. Skipped once clear() or a merge
   *  reconcile superseded it. */
  const applyPersisted = (next: T, epoch: number) => {
    if (epoch !== writeEpoch) {
      return;
    }
    /* Only the read settles `hasLoaded`: a write landing says what the disk now
       holds, not that the list it was merged into has been read. */
    value = next;
    emit();
  };

  /**
   * Writes the current target, then the newest target if one arrived while that
   * write was in flight. One write at a time keeps the disk on the last choice;
   * replacing {@link requested} keeps superseded choices off the disk.
   */
  const drainWrites = async () => {
    if (writing) {
      return;
    }
    writing = true;
    try {
      while (requested !== undefined) {
        const target = requested;
        requested = undefined;
        inFlight = target;
        const epoch = writeEpoch;
        try {
          // eslint-disable-next-line no-await-in-loop -- one write at a time is the ordering guarantee
          await setAccountMetadata(key, serialize(target));
        } catch {
          inFlight = undefined;
          // Drop every pending choice, including one that arrived while this
          // write was in flight: the disk just refused, so retrying the newest
          // one here would only repeat the toast and could reorder choices.
          // The stored value stays the last one that landed, so the app keeps
          // showing it: the toast is the only claim the new choice failed.
          requested = undefined;
          toast.error(i18n.t('common.couldNotSaveSetting'));
          if (!loadSettled && !cleared) {
            // Nothing of the user's is pending any more; let the in-flight
            // initial read describe what is actually stored.
            dirty = false;
          }
          break;
        }
        applyPersisted(target, epoch);
        inFlight = undefined;
      }
    } finally {
      writing = false;
      releaseDrainWaiters();
    }
  };

  const whenPersisted = async (): Promise<void> => {
    if (!writing && requested === undefined) {
      return;
    }
    await new Promise<void>(resolve => {
      drainWaiters.push(resolve);
    });
  };

  const load = async () => {
    // A clear() that runs after this read starts must win over the bytes it
    // returns, so the read remembers the epoch it began under.
    const loadEpoch = clearEpoch;
    const deletion = clearDeletion;
    try {
      if (deletion && !(await deletion)) {
        // The delete a clear() queued never landed, so the disk still holds the
        // snapshot that clear removed. The clear wins: drop it.
        return;
      }
      const raw = await readStoredValueWithRetry(key);
      if (clearEpoch !== loadEpoch) {
        // A clear() ran while this read was out. Its snapshot belongs to the
        // state that clear reset, so neither branch below may apply it, even
        // when a set() has re-opened the merge path since.
        return;
      }
      if (!dirty) {
        value = parse(raw);
      } else if (mergeOnLoad && !cleared) {
        // The disk value and the choice made before the read settled are both
        // real entries, so the merge is applied at once: it already contains
        // everything the disk holds. The write that raced the read is
        // superseded here (its own value is inside the merge), so it must not
        // paint over the merged value; the write queued below reconciles the
        // disk with the merged list.
        const pendingBeforeLoad = currentRequested();
        writeEpoch += 1;
        inFlight = undefined;
        value = mergeOnLoad(parse(raw), pendingBeforeLoad);
        emit();
        requested = value;
        void drainWrites();
      }
    } catch {
      // Keep the default on read failure — this runs on mount, before the
      // user has done anything, so there's nothing actionable to tell them.
      // The SecureStore read path already reports the rejection once (a
      // warning event for a real failure, a breadcrumb for a locked device's
      // refusal), so a second record here would only duplicate it.
    } finally {
      loadSettled = true;
      hasLoaded = true;
      markLoaded();
      emit();
    }
  };

  /**
   * Deletes the stored value and reports whether the delete landed, so a read
   * that starts after a clear() knows whether the disk can still hold the
   * snapshot the clear removed.
   */
  const remove = async (): Promise<boolean> => {
    try {
      await deleteAccountMetadata(key);
      return true;
    } catch {
      // Best effort; the in-memory value is already reset.
      return false;
    }
  };

  const preload = () => {
    if (!loadStarted) {
      loadStarted = true;
      void load();
    }
  };

  return {
    /** Start the disk read without registering a listener (module-scope warm-up). */
    preload,
    /** Start the disk read and await it. For callers outside a React tree. */
    whenLoaded: async () => {
      preload();
      await loaded;
    },
    subscribe: (listener: () => void) => {
      if (!loadStarted) {
        loadStarted = true;
        void load();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => value,
    getHasLoaded: () => hasLoaded,
    /**
     * The value the next relative change starts from: the newest requested
     * target (or the one being written) while a write is pending, otherwise the
     * durable value. Toggles and list edits read this so rapid changes each
     * build on the state the person last asked for, not a render that a pending
     * write has not reached yet.
     */
    getRequested: currentRequested,
    set: (next: T) => {
      requested = next;
      dirty = true;
      cleared = false;
      void drainWrites();
    },
    /** Resolves once every requested value has been written or dropped. */
    whenPersisted,
    /**
     * Whether a choice is queued or on its way to disk. The language follow
     * reads this to admit a device change only when no manual pick is
     * in flight: a pick applies in memory before its write lands, so
     * `getRequested()` alone misses the window where a pick has changed
     * the active language but the preference still reads the old one. The
     * persist-then-apply write is surfaced through its own flag here, which
     * leaves `getRequested()` semantics unchanged for every other reader.
     */
    hasPendingWrite: () =>
      requested !== undefined || inFlight !== undefined || asyncWriteTarget !== undefined,
    /**
     * The choice whose persist-then-apply write is on disk's way, or undefined.
     * The language follow's restore reads this: `getRequested()` deliberately
     * keeps reporting the durable value while the write runs, so the only place
     * the still-unpersisted pick lives is here.
     */
    getPendingWriteTarget: (): T | undefined => asyncWriteTarget,
    /**
     * Persist-then-apply write for callers that must not change memory on a
     * failed disk write (e.g. language apply). Writes disk first; on success
     * updates memory and emits, returning true. On failure shows the existing
     * toast, leaves memory unchanged, and returns false. `toastLng` pins the
     * toast language when the caller already switched the active language.
     *
     * A `clear()` that runs during either wait supersedes the choice: a write
     * that has not started is skipped, the value is never applied, and the call
     * returns false without a toast, because nothing failed — the value was
     * reset on purpose. A write already handed to the store cannot be recalled.
     */
    setAsync: async (next: T, toastLng?: string): Promise<boolean> => {
      // The fence `clear()` sets for a write already on its way to disk. A
      // sign-out during either await below reset this preference, and this
      // choice belongs to the account that just left: it must not land on disk
      // (when it has not started yet) and must not repaint memory afterwards.
      const epoch = clearEpoch;
      // The write is the pick's whole file: the target is visible to a racing
      // reader (the device-language follow) from the moment the write is
      // asked, not only once it reaches the disk helper. `drainWrites` sets
      // the same in-flight field for a queued `set()` write. A failed write
      // keeps the memory value — the caller rolls its own apply back.
      asyncWriteTarget = next;
      await whenPersisted();
      if (epoch !== clearEpoch) {
        return false;
      }
      try {
        await setAccountMetadata(key, serialize(next));
      } catch {
        // A superseded choice is not a save failure, so it does not toast: the
        // reset already explains why the value is gone.
        if (epoch === clearEpoch) {
          toast.error(
            toastLng
              ? i18n.t('common.couldNotSaveSetting', { lng: toastLng })
              : i18n.t('common.couldNotSaveSetting')
          );
        }
        return false;
      } finally {
        if (asyncWriteTarget === next) {
          asyncWriteTarget = undefined;
        }
      }
      if (epoch !== clearEpoch) {
        return false;
      }
      value = next;
      dirty = true;
      hasLoaded = true;
      emit();
      return true;
    },
    /** Reset memory and disk (e.g. on sign-out). */
    clear: () => {
      // A write already on its way to disk must not repaint the value this
      // clear resets; the delete it queues behind still removes the entry.
      writeEpoch += 1;
      clearEpoch += 1;
      requested = undefined;
      inFlight = undefined;
      asyncWriteTarget = undefined;
      value = defaultValue;
      // Keep dirty set so an in-flight initial read does not restore the old
      // value after sign-out.
      dirty = true;
      // A clear before the initial load resolves must still win, even with
      // mergeOnLoad set.
      cleared = true;
      emit();
      // Recorded before clear() returns, so a read that starts right after it
      // waits for the delete instead of reading the snapshot this clear
      // removed. remove() never rejects, so the recorded promise is safe to
      // hold.
      clearDeletion = remove();
      void clearDeletion;
      releaseDrainWaiters();
    },
  };
}
