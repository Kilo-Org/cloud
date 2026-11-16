import { parseKiloWebPath } from '@kilocode/app-shared/universal-links';

/** Production web origin, used when the link carries no usable http(s) origin. */
const KILO_WEB_ORIGIN = 'https://app.kilo.ai';

/**
 * Web pages the app owns no screen for but the OS still delivers.
 *
 * Android `pathPattern` cannot exclude segments, so the organization root's
 * `/organizations/[^/]+` intent filter also matches `/organizations/new` and
 * `/organizations/create`. Those are the web create form — it is where the
 * account and the plan are asked — so the app hands them straight to the
 * browser instead of opening an unrelated screen or dropping the link.
 */
const BROWSER_ONLY_ORGANIZATION_PATHS = new Set(['/organizations/new', '/organizations/create']);

/** Loopback development authority, as `pathnameOf` accepts it. */
const LOOPBACK_AUTHORITY = /^(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/i;

/**
 * Origin to hand a browser page: the production origin, or the loopback
 * development one. Built from a host this module validated — never from the
 * raw authority, because `https://app.kilo.ai:pass@evil.com/…` starts with the
 * Kilo host but its real host is `evil.com`.
 */
function webOrigin(raw: string): string {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(raw.trim())?.[1];
  const loopback = authority === undefined ? null : LOOPBACK_AUTHORITY.exec(authority);
  if (loopback === null) {
    return KILO_WEB_ORIGIN;
  }
  const port = loopback[2] === undefined ? '' : `:${loopback[2]}`;
  return `http://${loopback[1]?.toLowerCase() ?? ''}${port}`;
}

/**
 * Pathname of a Kilo web/app-scheme link, or of a loopback development host.
 * Any other absolute host is not ours and yields `null`: a deep link must not
 * be able to make the app open a foreign page.
 */
function pathnameOf(raw: string): string | null {
  const webPath = parseKiloWebPath(raw);
  if (webPath !== null) {
    return webPath;
  }
  const absolute = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(raw.trim());
  if (absolute === null) {
    return raw.split(/[?#]/, 1)[0] ?? '';
  }
  if (!LOOPBACK_AUTHORITY.test(absolute[1] ?? '')) {
    return null;
  }
  return absolute[2] ?? '/';
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * The web URL to open instead of navigating, when `raw` names a page the app
 * has no screen for. `null` means the link is not one of those pages.
 */
export function browserHandoffUrl(raw: string): string | null {
  const pathname = pathnameOf(raw);
  if (pathname === null) {
    return null;
  }
  const decoded = decodePathname(pathname);
  if (decoded === null || !BROWSER_ONLY_ORGANIZATION_PATHS.has(decoded)) {
    return null;
  }
  return `${webOrigin(raw)}${decoded}`;
}

/**
 * Open a page the app cannot show. The opener is imported lazily: it pulls in
 * Expo's Linking and reads the build-time `__DEV__` global, and this module is
 * imported by pure suites that only map link paths.
 */
export async function openBrowserHandoff(url: string): Promise<void> {
  const { openExternalUrl } = await import('./external-link');
  await openExternalUrl(url);
}

export function isRemovedMobileDeepLink(raw: string): boolean {
  const pathname = (parseKiloWebPath(raw) ?? raw).split(/[?#]/, 1)[0] ?? '';
  try {
    const decodedPath = decodeURIComponent(pathname);
    return /^\/(?:(?:\(app\)|\(tabs\))\/)*(?:claw|kiloclaw|chat|onboarding|\(1_kiloclaw\))(?:\/|$)/.test(
      decodedPath
    );
  } catch {
    return false;
  }
}
