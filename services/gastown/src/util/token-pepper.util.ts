export function isTokenPepper(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}
