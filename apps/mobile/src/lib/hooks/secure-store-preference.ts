import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';
import { toast } from 'sonner-native';

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
  // A set() before the initial load resolves must win over the disk value.
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
      Sentry.captureException(error);
    } finally {
      hasLoaded = true;
      emit();
    }
  };

  const persist = async (next: T) => {
    try {
      await SecureStore.setItemAsync(key, serialize(next));
    } catch {
      // Keep the in-memory preference so the session still works, but the
      // change won't survive relaunch — tell the user so it's not a silent
      // surprise later.
      toast.error('Could not save setting');
    }
  };

  const remove = async () => {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Best effort; the in-memory value is already reset.
    }
  };

  return {
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
    /** Reset memory and disk (e.g. on sign-out). */
    clear: () => {
      value = defaultValue;
      dirty = false;
      emit();
      void remove();
    },
  };
}
