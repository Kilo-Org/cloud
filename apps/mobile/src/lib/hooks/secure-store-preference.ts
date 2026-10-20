import * as Sentry from '@sentry/react-native';
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
  let writing = false;
  let hasLoaded = false;
  let loadSettled = false;
  // A set() or clear() before the initial load resolves must win over the
  // disk value.
  let dirty = false;
  // A clear() before the initial load resolves must still win over the disk
  // value even when mergeOnLoad is set.
  let cleared = false;
  let loadStarted = false;
  /**
   * Bumped by clear(). A write that started under an earlier epoch still lands
   * (the delete queued behind it wins), but it must not repaint the value the
   * clear just reset.
   */
  let writeEpoch = 0;
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
   */
  const currentRequested = (): T => requested ?? inFlight ?? value;

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

  /** Applies a value the disk now holds. Skipped once clear() superseded it. */
  const applyPersisted = (next: T, epoch: number) => {
    if (epoch !== writeEpoch) {
      return;
    }
    value = next;
    hasLoaded = true;
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
          // The stored value stays the last one that landed, so the app keeps
          // showing it: the toast is the only claim the new choice failed.
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
    try {
      const raw = await readStoredValueWithRetry(key);
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
    } catch (error) {
      // Keep the default on read failure — this runs on mount, before the
      // user has done anything, so there's nothing actionable to tell them.
      // Just log so we can see failure rates.
      Sentry.captureException(error, {
        tags: {
          'error.subsystem': 'preferences',
          'error.operation': 'load_secure_store',
        },
      });
    } finally {
      loadSettled = true;
      hasLoaded = true;
      markLoaded();
      emit();
    }
  };

  const remove = async () => {
    try {
      await deleteAccountMetadata(key);
    } catch {
      // Best effort; the in-memory value is already reset.
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
      hasLoaded = true;
      void drainWrites();
    },
    /** Resolves once every requested value has been written or dropped. */
    whenPersisted,
    /**
     * Persist-then-apply write for callers that must not change memory on a
     * failed disk write (e.g. language apply). Writes disk first; on success
     * updates memory and emits, returning true. On failure shows the existing
     * toast, leaves memory unchanged, and returns false. `toastLng` pins the
     * toast language when the caller already switched the active language.
     */
    setAsync: async (next: T, toastLng?: string): Promise<boolean> => {
      await whenPersisted();
      try {
        await setAccountMetadata(key, serialize(next));
      } catch {
        toast.error(i18n.t('common.couldNotSaveSetting', toastLng ? { lng: toastLng } : undefined));
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
      requested = undefined;
      inFlight = undefined;
      value = defaultValue;
      // Keep dirty set so an in-flight initial read does not restore the old
      // value after sign-out.
      dirty = true;
      // A clear before the initial load resolves must still win, even with
      // mergeOnLoad set.
      cleared = true;
      emit();
      void remove();
      releaseDrainWaiters();
    },
  };
}
