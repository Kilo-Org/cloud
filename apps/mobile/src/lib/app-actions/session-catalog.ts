import { captureTelemetry } from '@/lib/telemetry/error-sink';

import {
  clearNativeSessionCatalog,
  setNativeSessionCatalogLock,
  setNativeSessionCatalogVisible,
} from './native-bridge';

/**
 * Fire the App Intents catalog clear without awaiting, so the caller stays
 * synchronous and never throws, and report a rejection instead of swallowing
 * it.
 *
 * The clear is idempotent — it drops the whole stored list — so the two
 * boundaries that call it (the privacy lock and the account boundary) never
 * have to coordinate, and a failed clear is retried by the next boundary or by
 * the next sync, which re-publishes the current account's titles.
 */
export function clearSessionCatalogBestEffort(): void {
  reportBestEffort('clear', async () => {
    await clearNativeSessionCatalog();
  });
}

/**
 * Fire the lock's terms for the entity catalog without awaiting.
 *
 * The native store keeps the instant the app leaves the foreground, so the
 * App Intents queries stop answering once the lock's interval has passed —
 * even though the app is backgrounded and no JavaScript runs. The push is
 * idempotent, and a failed one is retried by the next state change of the
 * lock's own switch.
 */
export function setSessionCatalogLockBestEffort(enabled: boolean, intervalMs: number): void {
  reportBestEffort('lock', () => {
    setNativeSessionCatalogLock(enabled, intervalMs);
  });
}

/**
 * Fire the catalog's visibility without awaiting.
 *
 * `false` keeps every stored title out of the App Intents answers; `true` lets
 * them through. The store starts closed on each launch, so a failed push can
 * only withhold, never expose: the next status change repeats it.
 */
export function setSessionCatalogVisibleBestEffort(visible: boolean): void {
  reportBestEffort('visibility', () => {
    setNativeSessionCatalogVisible(visible);
  });
}

/** Runs one catalog call, reporting a rejection under the catalog's subsystem. */
function reportBestEffort(
  operation: 'clear' | 'lock' | 'visibility',
  run: () => void | Promise<void>
): void {
  void (async () => {
    try {
      await run();
    } catch (error) {
      captureTelemetry({
        error,
        level: 'warning',
        tags: { 'error.subsystem': 'app-intent-catalog', 'error.operation': operation },
      });
    }
  })();
}
