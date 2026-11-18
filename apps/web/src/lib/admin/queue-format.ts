// Shared formatting helpers for admin "queue" style list/detail views
// (data exports, deletion queue, and similar operational dashboards).
// Kept in one place so a fix to relative-age rounding or token
// humanization applies everywhere it is used, instead of drifting
// across per-feature copies.

/** Renders an ISO timestamp using the browser locale, or an em dash when absent/invalid. */
export function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * Deterministic relative age between two timestamps. Using the server-provided
 * `asOf` instead of Date.now() keeps server and client renders consistent.
 */
export function formatAge(fromIso: string, asOfIso: string): string {
  const from = new Date(fromIso).getTime();
  const asOf = new Date(asOfIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(asOf)) return '—';
  const diffSeconds = Math.max(0, Math.round((asOf - from) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

/** snake_case or kebab-case tokens from the API become readable labels. */
export function humanizeToken(value: string): string {
  return value.replaceAll(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
}
