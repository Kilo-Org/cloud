/**
 * Telemetry for a failed `expo-secure-store` operation.
 *
 * Kept free of `expo-secure-store` (and of every native import) so the pure
 * suites that inject a fake store — `glanceable/persist`, `glanceable/waiting-ask`,
 * `deep-link-launch` — can report a failure without loading the native module
 * graph. The sink adapter itself stays in `error-sink.ts`.
 */

import { isProtectedDataAvailable, ProtectedDataUnavailableError } from '@/lib/protected-data';
import { addTelemetryBreadcrumb, captureTelemetry } from '@/lib/telemetry/error-sink';

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
 * The message expo-secure-store builds for `errSecInteractionNotAllowed`: its
 * iOS `KeyChainException` (`ios/SecureStoreExceptions.swift`) returns this text
 * from a fixed switch case, so it is the same on every OS version and in every
 * device locale. The rejection reaches JS as a `FunctionCallException` whose
 * `code` is the cause's `ERR_KEY_CHAIN`, which every keychain status shares, so
 * the message is the only stable marker of this one.
 */
const KEYCHAIN_INTERACTION_REFUSED_MESSAGE = 'User interaction is not allowed';

/**
 * Report one failed SecureStore operation at warning level.
 *
 * The fingerprint and tags name the operation, never the raw native message.
 * The key and the stored value are never attached: a stored value can be a
 * credential and the native error is built from the operation name, so the
 * event carries no key material, no credential and no token.
 *
 * A refusal from a locked device is not reported: iOS rejects every
 * `WHEN_UNLOCKED*` item with `errSecInteractionNotAllowed` until unlock, by
 * design. The cached protected-data state cannot recognise every one of them —
 * a background start after the screen locked can still read it as available,
 * and it can flip during the call — so the refusal itself is recognised too.
 * Such a refusal leaves a breadcrumb on the next event and files no event of
 * its own.
 */
export function reportSecureStoreFailure(operation: SecureStoreOperation, error: unknown): void {
  if (error instanceof ProtectedDataUnavailableError || !isProtectedDataAvailable()) {
    return;
  }
  if (error instanceof Error && error.message.includes(KEYCHAIN_INTERACTION_REFUSED_MESSAGE)) {
    addTelemetryBreadcrumb({
      category: 'secure_store',
      level: 'warning',
      message: 'keychain refused a call while the device was locked',
      data: { operation },
    });
    return;
  }
  captureTelemetry({
    error,
    level: 'warning',
    tags: { 'error.subsystem': 'secure_store', 'error.operation': operation },
    fingerprint: secureStoreFailureFingerprint(operation),
  });
}
