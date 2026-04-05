/**
 * localStorage utility that silently handles errors and server-side rendering.
 * Exports a localStorage-like interface that safely handles cases where
 * localStorage might not be available (e.g., private browsing mode, disabled storage, SSR).
 */

const IS_SERVER = typeof window === 'undefined';

// Note: Return types are intentionally omitted here for simplicity.
// The nullStorage object is only used as a fallback when localStorage is unavailable,
// and TypeScript can infer the types from the safeLocalStorage implementation below.
const nullStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

export const safeLocalStorage = IS_SERVER
  ? nullStorage
  : {
      getItem: (key: string): string | null => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key: string, value: string): void => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // Silently fail if localStorage is unavailable
        }
      },
      removeItem: (key: string): void => {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Silently fail if localStorage is unavailable
        }
      },
    };
