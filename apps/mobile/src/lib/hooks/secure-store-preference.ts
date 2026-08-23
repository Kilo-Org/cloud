import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { deleteAccountMetadata, setAccountMetadata } from '@/lib/auth/account-metadata-write';

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
}) {
  const { key, defaultValue, parse, serialize } = options;
  let value = defaultValue;
  let hasLoaded = false;
  // A set() or clear() before the initial load resolves must win over the
  // disk value.
  let dirty = false;
  let loadStarted = false;
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
      }
    } catch (error) {
      // Keep the default on read failure — this runs on mount, before the
      // user has done anything, so there's nothing actionable to tell them.
      // Just log so we can see failure rates.
      Sentry.captureException(error, {
        tags: { 'error.subsystem': 'preferences', 'error.operation': 'load_secure_store' },
      });
    } finally {
      hasLoaded = true;
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

  return {
    /** Start the disk read without registering a listener (module-scope warm-up). */
    preload: () => {
      if (!loadStarted) {
        loadStarted = true;
        void load();
      }
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
      hasLoaded = true;
      emit();
      void persist(next);
    },
    /**
     * Persist-then-apply write for callers that must not change memory on a
     * failed disk write (e.g. language apply). Writes disk first; on success
     * updates memory and emits, returning true. On failure shows the existing
     * toast, leaves memory unchanged, and returns false.
     */
    setAsync: async (next: T): Promise<boolean> => {
      try {
        await setAccountMetadata(key, serialize(next));
      } catch {
        toast.error(i18n.t('common.couldNotSaveSetting'));
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
      emit();
      void remove();
    },
  };
}
