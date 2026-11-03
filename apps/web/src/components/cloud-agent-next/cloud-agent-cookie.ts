import type * as z from 'zod';

/**
 * Cookies the server renders Cloud Agent pages with. Each one is kept on the Cloud
 * Agent routes of one account (personal or one organization) and names its user.
 */

export function cloudAgentCookiePath(organizationId: string | null): string {
  return organizationId ? `/organizations/${encodeURIComponent(organizationId)}/cloud` : '/cloud';
}

/** The decoded value, or null when it is missing, malformed or another user's. */
export function parseCloudAgentCookie<T extends { u: string }>(
  value: string | undefined,
  userId: string,
  schema: z.ZodType<T>
): T | null {
  if (!value) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success && parsed.data.u === userId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeCloudAgentCookie(
  name: string,
  encodedValue: string,
  organizationId: string | null
): void {
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodedValue}; Path=${cloudAgentCookiePath(organizationId)}; Max-Age=31536000; SameSite=Lax${secure}`;
  } catch {
    // Without the cookie, the next load renders without the stored value first.
  }
}
