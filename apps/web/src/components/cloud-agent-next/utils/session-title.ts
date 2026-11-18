import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

/** Internal creation titles are placeholders, not user-facing chat names. */
export function getChatDisplayTitle(title: string | null | undefined): string {
  return title?.trim() && !isDefaultSessionTitle(title) ? title : 'New chat';
}

/**
 * Keep a real title when an older or out-of-order update still carries the
 * creation placeholder. Session events and list reads can arrive in either
 * order, and a placeholder is never newer than a real title.
 */
export function keepRealSessionTitle(
  current: string | null | undefined,
  incoming: string | null | undefined
): string | null | undefined {
  if (incoming?.trim() && !isDefaultSessionTitle(incoming)) return incoming;
  if (current?.trim() && !isDefaultSessionTitle(current)) return current;
  return incoming;
}
