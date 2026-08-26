/**
 * Runtime-validates an Expo Router param. Route generics only describe the
 * shape TypeScript hopes for — a malformed or hand-built deep link can still
 * hand a screen `undefined` (missing segment) or a `string[]` (repeated
 * segment), so every dynamic route param must be checked before it's used
 * in a query or mutation.
 *
 * Returns `null` for a missing/array value, or — when `allowed` is given —
 * for any value outside that allowlist (narrowing the result to the
 * allowlist's element type).
 */
export function parseParam<T extends string = string>(
  value: string | string[] | undefined,
  allowed?: readonly T[]
): T | null {
  if (value === undefined || Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (allowed && !allowed.includes(value as T)) {
    return null;
  }
  return value as T;
}

/**
 * Runtime-validates a dynamic route param that must be a positive integer,
 * such as a PR number.
 *
 * `Number.parseInt` stops at the first non-digit, so `12abc` and `1.5` would
 * silently resolve to PR 12 and PR 1 instead of the invalid-route state. The
 * whole segment must be digits, and the result must stay exactly
 * representable, before it is used in a query.
 */
export function parsePositiveIntParam(value: string | string[] | undefined): number | null {
  const raw = parseParam(value);
  if (raw === null || !/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
