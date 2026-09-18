/**
 * Single source of truth for the pinned producer/consumer contract between the
 * cloud-agent-sdk's remote-session exit messages and the mobile surfaces that
 * classify them (the Active now list and the session detail).
 *
 * The barrel import is not used because the mobile test runner cannot resolve
 * the SDK's transitive web-only `@/...` aliases; the literals must stay in sync
 * with the SDK source. Changing them requires updating this classifier.
 */

/**
 * Pinned to the SDK's exported `REMOTE_SESSION_EXIT_NOT_SUPPORTED` constant
 * (see `packages/cloud-agent-sdk/src/session.ts`).
 */
export const REMOTE_SESSION_EXIT_NOT_SUPPORTED_MESSAGE =
  'Remote session exit is not supported for the current session';

/**
 * Internal SDK message: `cli-live-transport` throws this when the live catalog
 * reports a non-`true` `canExitSession`. The SDK does not export the constant,
 * so the literal is matched here.
 */
export const REMOTE_SESSION_EXIT_UNAVAILABLE_MESSAGE =
  'Remote session exit is unavailable for the current session';

export const REMOTE_SESSION_EXIT_UPGRADE_PREFIX = 'Remote slash commands require a newer Kilo CLI';

const NON_RETRYABLE_EXIT_MESSAGES: ReadonlySet<string> = new Set([
  REMOTE_SESSION_EXIT_NOT_SUPPORTED_MESSAGE,
  REMOTE_SESSION_EXIT_UNAVAILABLE_MESSAGE,
]);

/**
 * True when a pinned SDK exit message is permanent, so a retry can never
 * succeed. Matched in English because the producer is the SDK.
 */
export function isNonRetryableExitError(message: string): boolean {
  if (NON_RETRYABLE_EXIT_MESSAGES.has(message)) {
    return true;
  }
  return message.startsWith(REMOTE_SESSION_EXIT_UPGRADE_PREFIX);
}
