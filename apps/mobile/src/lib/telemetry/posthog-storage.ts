import { File, Paths } from 'expo-file-system';

/**
 * PostHog SDK storage files. Verified in posthog-react-native 4.59.0
 * `dist/storage.js`: `EVENTS_STORAGE_FILE` and `LOGS_STORAGE_FILE`.
 * The key argument to `getItem`/`setItem` is the file name.
 */
export const POSTHOG_STORAGE_FILES = ['.posthog-rn.json', '.posthog-rn-logs.json'] as const;

/**
 * PostHogCustomStorage backed by `Paths.cache`. iOS Caches is not exposed by
 * UIFileSharingEnabled and is not backed up, so telemetry data stays outside
 * the user-browsable Documents container.
 *
 * Tradeoff: iOS can evict Caches under storage pressure. The cost is a lost
 * queued-event batch and a reset anonymous id, which is acceptable for optional
 * analytics and strictly better than leaving identified telemetry in a
 * user-browsable directory.
 *
 * Do not use `persistence: 'memory'` — Application Installed and Application
 * Updated events do not work with it (SDK docs).
 */

// ---- seal ----

let sealed = false;

/** Seal the storage so the SDK cannot write through it. A sealed `setItem`
 *  returns immediately; a sealed `getItem` returns `null`. */
export function sealPostHogStorage(): void {
  sealed = true;
}

/** Unseal the storage so a new SDK instance can persist again. */
export function unsealPostHogStorage(): void {
  sealed = false;
}

export function isPostHogStorageSealed(): boolean {
  return sealed;
}

// ---- custom storage ----

export const posthogCustomStorage = {
  async getItem(key: string): Promise<string | null> {
    if (sealed) {
      return null;
    }
    try {
      const file = new File(Paths.cache, key);
      if (!file.exists) {
        return null;
      }
      return await file.text();
    } catch {
      return null;
    }
  },

  // The `PostHogCustomStorage` interface allows `void | Promise<void>`.
  // This implementation is synchronous — remove the `async` keyword instead
  // of suppressing `require-await`.
  setItem(key: string, value: string): void {
    if (sealed) {
      return;
    }
    try {
      const file = new File(Paths.cache, key);
      file.write(value);
    } catch {
      // best-effort persistence — a failed write is lost queued events,
      // which is acceptable for optional analytics.
    }
  },
};

// ---- purge ----

/**
 * Delete both PostHog storage files from the Caches and legacy Documents
 * directories. Must be called only after `sealPostHogStorage()` — the SDK
 * persists through a 100 ms debounce (`PERSIST_DEBOUNCE_MS` in
 * `dist/storage.js`), so a write scheduled before the purge can recreate a
 * file after this function deletes it. Sealing the sink first makes that
 * structurally impossible.
 */
export function purgePostHogPersistence(): void {
  if (!sealed) {
    return;
  }

  for (const name of POSTHOG_STORAGE_FILES) {
    for (const base of [Paths.cache, Paths.document]) {
      try {
        const file = new File(base, name);
        if (file.exists) {
          file.delete();
        }
      } catch {
        // file-not-found and permission edge cases are expected;
        // do not let a stale file handle crash the teardown.
      }
    }
  }
}

// ---- test reset ----

export function resetPostHogStorageForTests(): void {
  sealed = false;
}
