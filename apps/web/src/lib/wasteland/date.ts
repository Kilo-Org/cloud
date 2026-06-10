/**
 * Date helpers for DoltHub-sourced values.
 *
 * DoltHub returns MySQL DATETIME strings in the form `"YYYY-MM-DD HH:MM:SS"`
 * without a timezone suffix — the underlying data is UTC but the string is
 * not ISO-8601, so `new Date(str)` is browser-dependent (typically parsed
 * as local time, producing values that read as hours off in relative
 * labels).
 *
 * Always route DoltHub timestamps through `parseDoltDate` before formatting.
 */

/**
 * Parse a DoltHub MySQL-style DATETIME string, treating it as UTC when no
 * timezone marker is present. Returns `null` for empty / non-string / invalid
 * inputs so callers can branch on the missing case without try/catch.
 */
export function parseDoltDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Already has a timezone marker (Z or ±HH:MM) → trust it.
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value);
  // MySQL `YYYY-MM-DD HH:MM:SS` → normalize to ISO-8601 UTC.
  const normalized = value.includes('T') ? `${value}Z` : `${value.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Most recent timestamp out of two DoltHub datetimes, in epoch ms. */
export function lastActivityMs(updatedAt: unknown, createdAt: unknown): number {
  const updated = parseDoltDate(updatedAt)?.getTime() ?? 0;
  const created = parseDoltDate(createdAt)?.getTime() ?? 0;
  return Math.max(updated, created);
}
