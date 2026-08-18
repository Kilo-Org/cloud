import { SHARE_PAYLOAD_MAX_ENTRIES, type ShareId } from '@/lib/share-payload';

export type PendingShareNavigation = { href: string; shareId: ShareId | null };

/**
 * Narrow a pending navigation to the delivery case: `shareId` is a string.
 * A null `shareId` means the gate dismissed to a non-share destination (e.g.
 * Review PR) that must push `href` without delivering a payload.
 */
export function shareDeliveryShareId(
  pending: PendingShareNavigation
): pending is PendingShareNavigation & { shareId: ShareId } {
  return pending.shareId !== null;
}

/** FIFO of committed share destinations waiting for gate dismiss + delivery. */
const pendingQueue: PendingShareNavigation[] = [];

export function setPendingShareNavigation(next: PendingShareNavigation): void {
  pendingQueue.push(next);
  // Store evicts oldest beyond the same cap; keep navigation queue in lockstep.
  while (pendingQueue.length > SHARE_PAYLOAD_MAX_ENTRIES) {
    pendingQueue.shift();
  }
}

/** Read-and-remove the oldest pending navigation, or null when empty. */
export function takePendingShareNavigation(): PendingShareNavigation | null {
  return pendingQueue.shift() ?? null;
}

/** Append the share delivery params to a route path. */
export function appendShareParams(
  base: string,
  shareId: ShareId,
  options: { autoSend?: boolean } = {}
): string {
  const separator = base.includes('?') ? '&' : '?';
  const autoSend = options.autoSend === true ? '&autoSend=1' : '';
  return `${base}${separator}shareId=${encodeURIComponent(shareId)}${autoSend}`;
}

/** Parse the destination params a focused delivery must set from a pending href. */
export function parseShareHrefParams(href: string): { organizationId: string | undefined } {
  const queryStart = href.indexOf('?');
  if (queryStart === -1) {
    return { organizationId: undefined };
  }
  const query = href.slice(queryStart + 1);
  if (!query) {
    return { organizationId: undefined };
  }
  try {
    const params = new URLSearchParams(query);
    const organizationId = params.get('organizationId');
    return { organizationId: organizationId ?? undefined };
  } catch {
    return { organizationId: undefined };
  }
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

/** Test-only: wipe the pending queue between cases. */
export function __resetPendingShareNavigationForTests(): void {
  pendingQueue.length = 0;
}
