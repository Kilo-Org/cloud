/**
 * WebSocket origin predicate for the Durable Object /stream endpoint.
 */

/**
 * Decide whether a WebSocket upgrade Origin header is allowed for the DO
 * `/stream` route. Preserves existing semantics:
 *   - empty allowlist permits everything,
 *   - `null` and `'null'` always permit (non-browser clients),
 *   - explicitly listed origins permit.
 *
 * Also permits `chrome-extension://` and `moz-extension://` origins because
 * Firefox extension side-panels use per-install UUIDs that cannot be
 * value-allowlisted. The stream ticket is the real authentication boundary.
 */
export function isAllowedStreamWebSocketOrigin(
  origin: string | null,
  wsAllowedOrigins: string
): boolean {
  // null and 'null' always permit (non-browser contexts)
  if (origin === null || origin === 'null') return true;

  const allowedOrigins = wsAllowedOrigins
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  // Empty allowlist permits all origins
  if (allowedOrigins.length === 0) return true;

  // Explicitly listed origins permit
  if (allowedOrigins.includes(origin)) return true;

  // Browser extension origins: Chrome and Firefox side-panels
  // cannot be value-allowlisted because Firefox uses per-install UUIDs.
  // /stream is ticket-authenticated.
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
    return true;
  }

  return false;
}
