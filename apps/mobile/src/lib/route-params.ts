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
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (allowed && !allowed.includes(value as T)) {
    return null;
  }
  return value as T;
}
