import { timingSafeEqual } from '@kilocode/encryption';

export function isCronAuthorizationValid(authHeader: string | null, cronSecret: string): boolean {
  if (!authHeader) return false;
  return timingSafeEqual(authHeader, `Bearer ${cronSecret}`);
}
