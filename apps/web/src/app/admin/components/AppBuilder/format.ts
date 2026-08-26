import { formatDistanceToNow } from 'date-fns';

/**
 * Formats a nullable ISO timestamp string as relative time (e.g. "3 hours ago").
 * Returns "Never" when the timestamp is null, matching App Builder's semantics
 * for fields such as `last_message_at` that may not have occurred yet.
 */
export function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return 'Never';
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

/**
 * Formats an ISO timestamp string as a locale-aware absolute date/time string,
 * intended for tooltips that accompany `formatRelativeTime`.
 */
export function formatAbsoluteTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}
