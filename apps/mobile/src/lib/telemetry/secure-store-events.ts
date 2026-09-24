/**
 * Telemetry for a failed `expo-secure-store` operation.
 *
 * Kept free of `expo-secure-store` (and of every native import) so the pure
 * suites that inject a fake store — `glanceable/persist`, `glanceable/waiting-ask`,
 * `deep-link-launch` — can report a failure without loading the native module
 * graph. The sink adapter itself stays in `error-sink.ts`.
 */

import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * Which SecureStore call rejected. `read` is `getItemAsync`
 * (`getValueWithKeyAsync` in the native layer), `write` is `setItemAsync`
 * (`setValueWithKeyAsync`), `delete` is `deleteItemAsync`.
 */
export type SecureStoreOperation = 'read' | 'write' | 'delete';

/**
 * Stable Sentry fingerprint for one SecureStore failure. It names the
 * operation only: the native message ("Calling the 'setValueWithKeyAsync'
 * function has failed") varies with the platform, OS version and keychain
 * status, so fingerprinting on it would scatter one failure across many
 * issues instead of grouping it on the operation that failed.
 */
function secureStoreFailureFingerprint(operation: SecureStoreOperation): readonly string[] {
  return ['secure-store-failure', operation];
}

/**
 * Report one failed SecureStore operation at warning level.
 *
 * The fingerprint and tags name the operation, never the raw native message.
 * The key and the stored value are never attached: a stored value can be a
 * credential and the native error is built from the operation name, so the
 * event carries no key material, no credential and no token.
 */
export function reportSecureStoreFailure(operation: SecureStoreOperation, error: unknown): void {
  captureTelemetry({
    error,
    level: 'warning',
    tags: { 'error.subsystem': 'secure_store', 'error.operation': operation },
    fingerprint: secureStoreFailureFingerprint(operation),
  });
}
