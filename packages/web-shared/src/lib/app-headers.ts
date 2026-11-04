/**
 * The app-info request headers the first-party mobile client sends, and the
 * rules every server surface that reads them shares: the request-timing
 * dimensions and the minimum-version gate. Kept in one module so the two
 * cannot drift apart.
 *
 * Pure: no `server-only`, no database, so both a bare timing line builder and
 * the gate in front of the tRPC procedures can import it.
 */

/**
 * Anything that reads a request header by name: `Headers`, a Next request's
 * header list, or a fake in a test.
 */
export type AppHeaderList = { get(name: string): string | null };

export const APP_CLIENT_HEADER = 'x-kilo-client';
export const APP_PLATFORM_HEADER = 'x-kilo-app-platform';
export const APP_VERSION_HEADER = 'x-kilo-app-version';

/** The `x-kilo-client` value the mobile app sends. */
export const MOBILE_CLIENT = 'mobile';

/** Whether an `x-kilo-client` value names the first-party mobile app. */
export function isMobileClient(client: string | null | undefined): boolean {
  return client === MOBILE_CLIENT;
}

/** The platforms `x-kilo-app-platform` names. Any other value is unknown. */
export const KNOWN_PLATFORMS = ['ios', 'android'] as const;
export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number];

export function isKnownPlatform(value: string | null | undefined): value is KnownPlatform {
  return value != null && KNOWN_PLATFORMS.some(platform => platform === value);
}

/** The accepted app version shape: dot-separated numbers, e.g. `1.0.4`. */
export const APP_VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * Whether a header value has the app version shape. Length limits belong to the
 * caller that sets one.
 */
export function isAppVersion(value: string | null | undefined): value is string {
  return value != null && APP_VERSION_PATTERN.test(value);
}
