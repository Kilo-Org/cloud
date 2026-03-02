/**
 * Extract the token from an `Authorization: Bearer <token>` header value.
 * The "Bearer" prefix is matched case-insensitively per RFC 6750 §2.1.
 * Returns `null` if the header is missing or malformed.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (trimmed.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return trimmed.slice(7).trim() || null;
}
