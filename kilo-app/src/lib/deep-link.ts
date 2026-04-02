import { type Href } from 'expo-router';

export type PendingDeepLink = {
  targetRoute: Href;
  organizationId?: string;
};

let pending: PendingDeepLink | null = null;
let listener: ((link: PendingDeepLink) => void) | null = null;

function setPendingDeepLink(link: PendingDeepLink) {
  if (listener) {
    // Warm start: deliver directly, don't store (avoids replay on remount)
    listener(link);
  } else {
    // Cold start: stash for consumePendingDeepLink() on first mount
    pending = link;
  }
}

export function consumePendingDeepLink(): PendingDeepLink | null {
  const link = pending;
  pending = null;
  return link;
}

/** Subscribe to deep links arriving while the app is open. */
export function onPendingDeepLink(handler: (link: PendingDeepLink) => void): () => void {
  listener = handler;
  return () => {
    if (listener === handler) {
      listener = null;
    }
  };
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
 * Every recognised URL is stored as a pending deep link so the app can
 * navigate there after auth completes (if the user isn't logged in).
 * The rewritten path is also returned for direct navigation when the
 * user is already authenticated.
 *
 * - Non-org routes: stored + direct rewrite returned.
 * - Org-scoped routes: stored (with orgId for context switch),
 *   returns `/(app)` so the app layout picks it up.
 * - Unrecognised paths: returned as-is (Expo Router default handling).
 */
export function resolveDeepLink(raw: string): string {
  const pathname = toPathname(raw);
  if (pathname == null) {
    return raw;
  }

  // /claw → instance list (personal context)
  if (pathname === '/claw' || pathname === '/claw/') {
    setPendingDeepLink({ targetRoute: INSTANCE_LIST });
    return INSTANCE_LIST as string;
  }

  // /profile → profile screen
  if (pathname === '/profile' || pathname === '/profile/') {
    setPendingDeepLink({ targetRoute: PROFILE });
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
