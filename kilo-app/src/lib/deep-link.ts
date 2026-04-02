import { type Href } from 'expo-router';

type PendingDeepLink = {
  targetRoute: Href;
  organizationId: string;
};

let pending: PendingDeepLink | null = null;

function setPendingDeepLink(link: PendingDeepLink) {
  pending = link;
}

export function consumePendingDeepLink(): PendingDeepLink | null {
  const link = pending;
  pending = null;
  return link;
}

/**
 * Normalise an incoming URL (full or path-only) to a bare pathname.
 * Returns `null` when the URL doesn't belong to our domain.
 */
function toPathname(raw: string): string | null {
  // Already a relative path
  if (raw.startsWith('/')) {
    return raw;
  }

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    if (host !== 'app.kilo.ai') {
      return null;
    }
    return url.pathname;
  } catch {
    return null;
  }
}

const ORG_CLAW_RE = /^\/organizations\/([^/]+)\/claw\/?$/;
const ORG_RE = /^\/organizations\/([^/]+)\/?$/;

const INSTANCE_LIST: Href = '/(app)/(tabs)/(1_kiloclaw)/' as Href;
const PROFILE: Href = '/(app)/profile' as Href;

/**
 * Map an incoming web URL / path to an internal app route.
 *
 * - Simple routes are returned directly as a rewritten path string.
 * - Org-scoped routes store a pending deep link (for context switching)
 *   and return `/(app)` so the app layout can pick it up.
 * - Unrecognised paths are returned as-is (Expo Router's default handling).
 */
export function resolveDeepLink(raw: string): string {
  const pathname = toPathname(raw);
  if (pathname == null) {
    return raw;
  }

  // /claw → instance list (personal context)
  if (pathname === '/claw' || pathname === '/claw/') {
    return INSTANCE_LIST as string;
  }

  // /profile → profile screen
  if (pathname === '/profile' || pathname === '/profile/') {
    return PROFILE as string;
  }

  // /organizations/[orgId]/claw → switch to org context + instance list
  const orgClawMatch = ORG_CLAW_RE.exec(pathname);
  if (orgClawMatch?.[1]) {
    setPendingDeepLink({
      targetRoute: INSTANCE_LIST,
      organizationId: orgClawMatch[1],
    });
    return '/(app)';
  }

  // /organizations/[orgId] → switch to org context + profile
  const orgMatch = ORG_RE.exec(pathname);
  if (orgMatch?.[1]) {
    setPendingDeepLink({
      targetRoute: PROFILE,
      organizationId: orgMatch[1],
    });
    return '/(app)';
  }

  return raw;
}
