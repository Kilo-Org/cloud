import { createHash } from 'node:crypto';

/**
 * Derive a deterministic Fly app name from a user ID.
 *
 * Must stay in sync with kiloclaw/src/fly/apps.ts (worker runtime).
 */
export function flyAppNameFromUserId(userId: string, prefix?: string): string {
  const hex = createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 20);
  return prefix ? `${prefix}-${hex}` : `acct-${hex}`;
}
