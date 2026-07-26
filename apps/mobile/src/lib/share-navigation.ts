import { type ShareId } from '@/lib/share-payload';

export type PendingShareNavigation = { href: string; shareId: ShareId };

let pending: PendingShareNavigation | null = null;

export function setPendingShareNavigation(next: PendingShareNavigation): void {
  pending = next;
}

/** Read-and-clear. */
export function takePendingShareNavigation(): PendingShareNavigation | null {
  const current = pending;
  pending = null;
  return current;
}

/**
 * True when a pending href's path (ignoring query params) matches the current
 * pathname. Both sides are normalized by stripping group segments like
 * `(app)`. A stale shareId on the URL must not make a focused destination look
 * unfocused — only the path is compared.
 *
 * `pathname` is the concrete Expo Router path from `usePathname()` (e.g.
 * `/agent-chat/ses_1`), not bracket-pattern segments from `useSegments()`.
 */
export function isShareNavigationTargetFocused(href: string, pathname: string): boolean {
  const normalizedHref = normalizePath(href.split('?')[0] ?? href);
  const normalizedPath = normalizePath(pathname.split('?')[0] ?? pathname);

  if (normalizedHref.length !== normalizedPath.length) {
    return false;
  }
  return normalizedHref.every((part, i) => part === normalizedPath[i]);
}

function normalizePath(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .filter(p => !(p.startsWith('(') && p.endsWith(')')));
}

/**
 * True when the navigation state still contains the share-gate route.
 * Delivery waits until the formSheet is fully gone — never a fixed timer.
 */
export function navigationContainsShareGate(state: unknown): boolean {
  if (!state || typeof state !== 'object') {
    return false;
  }
  const record = state as { name?: unknown; routes?: unknown; state?: unknown };
  if (record.name === 'share-gate') {
    return true;
  }
  if (Array.isArray(record.routes)) {
    for (const route of record.routes) {
      if (navigationContainsShareGate(route)) {
        return true;
      }
    }
  }
  if (record.state) {
    return navigationContainsShareGate(record.state);
  }
  return false;
}

/** Test-only: wipe the module slot between cases. */
export function __resetPendingShareNavigationForTests(): void {
  pending = null;
}
