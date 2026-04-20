/**
 * Storage utilities that silently handle errors and server-side rendering.
 * Export localStorage-like interfaces that safely handle cases where
 * browser storage might not be available (e.g., private browsing mode, disabled storage, SSR).
 */

const IS_SERVER = typeof window === 'undefined';

type SafeStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

// Note: Return types are intentionally omitted here for simplicity.
// The nullStorage object is only used as a fallback when localStorage is unavailable,
// and TypeScript can infer the types from the safeLocalStorage implementation below.
const nullStorage: SafeStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function createSafeStorage(getStorage: () => Storage): SafeStorage {
  return {
    getItem: (key: string): string | null => {
      try {
        return getStorage().getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key: string, value: string): void => {
      try {
        getStorage().setItem(key, value);
      } catch {
        // Silently fail if storage is unavailable
      }
    },
    removeItem: (key: string): void => {
      try {
        getStorage().removeItem(key);
      } catch {
        // Silently fail if storage is unavailable
      }
    },
  };
}

export const safeLocalStorage = IS_SERVER
  ? nullStorage
  : createSafeStorage(() => window.localStorage);

export const safeSessionStorage = IS_SERVER
  ? nullStorage
  : createSafeStorage(() => window.sessionStorage);
