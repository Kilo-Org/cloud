import { captureTelemetry } from '@/lib/telemetry/error-sink';

import { clearNativeSessionCatalog } from './native-bridge';

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
  void (async () => {
    try {
      await clearNativeSessionCatalog();
    } catch (error) {
      captureTelemetry({
        error,
        level: 'warning',
        tags: { 'error.subsystem': 'app-intent-catalog', 'error.operation': 'clear' },
      });
    }
  })();
}
