import { timingSafeEqual } from 'crypto';

export function isCronAuthorizationValid(authHeader: string | null, cronSecret: string): boolean {
  if (!authHeader) return false;
  const provided = Buffer.from(authHeader);
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
