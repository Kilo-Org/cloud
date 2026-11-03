/**
 * Resolves a connection error code against a fixed map of messages.
 *
 * Only the map's own entries are messages. Any other code gets the caller's
 * fallback string, so the result is always a string.
 */
export function resolveConnectionErrorMessage(
  messages: Record<string, string>,
  code: string,
  fallback: string
): string {
  return Object.hasOwn(messages, code) ? messages[code] : fallback;
}
