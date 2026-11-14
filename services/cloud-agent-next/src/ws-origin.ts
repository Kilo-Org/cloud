/**
 * Origin policy for the client-facing WebSocket routes of this Worker.
 *
 * Both routes authenticate with a signed stream ticket in the query string, so
 * the Origin check is an additional gate, not the authentication boundary.
 */

export type WebSocketOriginEnv = { WS_ALLOWED_ORIGINS?: string };

const BROWSER_EXTENSION_ORIGIN_PREFIXES = ['chrome-extension://', 'moz-extension://'];

/**
 * The request Origin must be allowlisted, absent, or `null`. An absent Origin
 * and the `null` serialization that non-browser clients send cannot be
 * attributed to a page, so they pass. An empty allowlist stays permissive.
 */
export function isAllowedWebSocketOrigin(
  env: WebSocketOriginEnv,
  origin: string | null | undefined
): boolean {
  const isRealOrigin = origin !== undefined && origin !== null && origin !== 'null';
  if (!isRealOrigin) return true;

  const allowedOrigins = (env.WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return allowedOrigins.length === 0 || allowedOrigins.includes(origin);
}

/**
 * The terminal policy, plus browser-extension origins. An extension origin
 * carries a per-install identifier (Firefox uses a random UUID), so it cannot be
 * value-allowlisted; the stream ticket authorizes the connection.
 */
export function isAllowedStreamWebSocketOrigin(
  env: WebSocketOriginEnv,
  origin: string | null | undefined
): boolean {
  if (isAllowedWebSocketOrigin(env, origin)) return true;
  return (
    typeof origin === 'string' &&
    BROWSER_EXTENSION_ORIGIN_PREFIXES.some(prefix => origin.startsWith(prefix))
  );
}
