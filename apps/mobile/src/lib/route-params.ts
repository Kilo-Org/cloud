/**
 * Runtime-validates an Expo Router param. Route generics only describe the
 * shape TypeScript hopes for — a malformed or hand-built deep link can still
 * hand a screen `undefined` (missing segment) or a `string[]` (repeated
 * segment), so every dynamic route param must be checked before it's used
 * in a query or mutation.
 *
 * Returns `null` for a missing or repeated/array value. The allowlist is the
 * only runtime validation a narrower string-literal union gets, so it is not
 * optional: a caller that wants `'review' | 'conversation'` must pass that
 * allowlist, and the one-argument form is typed `string | null`.
 */
export function parseParam(value: string | string[] | undefined): string | null;
export function parseParam<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[]
): T | null;
export function parseParam(
  value: string | string[] | undefined,
  allowed?: readonly string[]
): string | null {
  if (value === undefined || Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (allowed && !allowed.includes(value)) {
    return null;
  }
  return value;
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
