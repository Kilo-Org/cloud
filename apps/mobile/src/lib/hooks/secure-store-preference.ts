import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { deleteAccountMetadata, setAccountMetadata } from '@/lib/auth/account-metadata-write';

function noop(): void {
  // Placeholder until the promise executor hands over its resolve.
}

/**
 * Module-level store for a SecureStore-backed preference so every hook
 * instance (settings sheet, message list, new-session screen) shares one
 * value and one disk read. Consume via useSyncExternalStore.
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
  let hasLoaded = false;
  // A set() or clear() before the initial load resolves must win over the
  // disk value.
  let dirty = false;
  // A clear() before the initial load resolves must still win over the disk
  // value even when mergeOnLoad is set.
  let cleared = false;
  let loadStarted = false;
  let markLoaded = noop;
  // Resolves once the disk read settles, so a caller with no React tree (the
  // Android widget task) can await the stored value instead of reading the
  // default.
  const loaded = new Promise<void>(resolve => {
    markLoaded = resolve;
  });
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const load = async () => {
    try {
      const raw = await SecureStore.getItemAsync(key);
      if (!dirty) {
        value = parse(raw);
      } else if (mergeOnLoad && !cleared) {
        value = mergeOnLoad(parse(raw), value);
        // The pending write raced the disk read and already persisted only
        // the partial value; persist the merged value so the persisted list
        // is not overwritten.
        void persist(value);
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
      hasLoaded = true;
      markLoaded();
      emit();
    }
  };

  const persist = async (next: T) => {
    try {
      await setAccountMetadata(key, serialize(next));
    } catch {
      // Keep the in-memory preference so the session still works, but the
      // change won't survive relaunch — tell the user so it's not a silent
      // surprise later.
      toast.error(i18n.t('common.couldNotSaveSetting'));
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
    set: (next: T) => {
      value = next;
      dirty = true;
      cleared = false;
      hasLoaded = true;
      emit();
      void persist(next);
    },
    /**
     * Persist-then-apply write for callers that must not change memory on a
     * failed disk write (e.g. language apply). Writes disk first; on success
     * updates memory and emits, returning true. On failure shows the existing
     * toast, leaves memory unchanged, and returns false. `toastLng` pins the
     * toast language when the caller already switched the active language.
     */
    setAsync: async (next: T, toastLng?: string): Promise<boolean> => {
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
      value = defaultValue;
      // Keep dirty set so an in-flight initial read does not restore the old
      // value after sign-out.
      dirty = true;
      // A clear before the initial load resolves must still win, even with
      // mergeOnLoad set.
      cleared = true;
      emit();
      void remove();
    },
  };
}
