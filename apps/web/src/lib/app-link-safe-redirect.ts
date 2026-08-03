import { webPathToAppPath } from '@kilocode/app-shared/universal-links';

/** Unclaimed interstitial that finishes the hop client-side. Never add to UNIVERSAL_LINK_ROUTES. */
export const APP_LINK_HANDOFF_PATH = '/users/continue';

/** Default when `to` is absent or fails validation. */
export const APP_LINK_HANDOFF_FALLBACK = '/profile';

/**
 * Universal Links / App Links match on path only. A server redirect that lands the
 * browser on a claimed path gets routed into the native app, which breaks web login
 * (see /users/continue). Route those destinations through the unclaimed interstitial;
 * pass everything else through untouched.
 */
export function browserLandingPath(destination: string): string {
  if (!isAppLinkClaimed(destination)) {
    return destination;
  }
  return `${APP_LINK_HANDOFF_PATH}?to=${encodeURIComponent(destination)}`;
}

/** True when `destination` (path, optionally with query/fragment) is claimed by the app. */
export function isAppLinkClaimed(destination: string): boolean {
  const pathname = destination.split('?')[0]?.split('#')[0] ?? '';
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')) {
    return false;
  }
  const normalised =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return webPathToAppPath(normalised) !== null;
}

/**
 * Resolve the `to` query param of /users/continue to a safe destination.
 * Only table-claimed same-origin paths are accepted — that is the tight allowlist
 * that keeps this route from becoming an open redirect. Anything else falls back.
 */
export function resolveHandoffDestination(to: string | string[] | undefined): string {
  if (typeof to !== 'string' || !isAppLinkClaimed(to)) {
    return APP_LINK_HANDOFF_FALLBACK;
  }
  return to;
}
