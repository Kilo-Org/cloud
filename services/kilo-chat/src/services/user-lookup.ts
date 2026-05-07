import { getWorkerDb } from '@kilocode/db';
import { kilocode_users, user_auth_provider } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

export type UserDisplayInfo = {
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * Resolves display name and avatar URL for a batch of user IDs.
 *
 * - Bot member IDs (prefix `bot:`) are not queried — they get { displayName: null, avatarUrl: null }.
 * - For real users: LEFT JOINs kilocode_users with user_auth_provider.
 * - Resolution: auth provider display_name → google_user_name → null
 * - Avatar: auth provider avatar_url → google_user_image_url → null
 * - When a user has multiple auth providers, pick the row with the most recent
 *   created_at that has a non-null display_name; if none, use the most recent row.
 * - Avatar follows the same row as display_name (the display_name winner's avatar
 *   is used even if a more recent provider row exists without a display_name).
 */
export async function resolveUserDisplayInfo(
  connectionString: string,
  userIds: string[]
): Promise<Map<string, UserDisplayInfo>> {
  const result = new Map<string, UserDisplayInfo>();

  if (userIds.length === 0) {
    return result;
  }

  // Separate bots from real users
  const botIds: string[] = [];
  const realUserIds: string[] = [];
  for (const id of userIds) {
    if (id.startsWith('bot:')) {
      botIds.push(id);
    } else {
      realUserIds.push(id);
    }
  }

  // Bot members always get null info
  for (const id of botIds) {
    result.set(id, { displayName: null, avatarUrl: null });
  }

  if (realUserIds.length === 0) {
    return result;
  }

  const db = getWorkerDb(connectionString);

  const rows = await db
    .select({
      id: kilocode_users.id,
      google_user_name: kilocode_users.google_user_name,
      google_user_image_url: kilocode_users.google_user_image_url,
      display_name: user_auth_provider.display_name,
      avatar_url: user_auth_provider.avatar_url,
      created_at: user_auth_provider.created_at,
    })
    .from(kilocode_users)
    .leftJoin(user_auth_provider, eq(user_auth_provider.kilo_user_id, kilocode_users.id))
    .where(inArray(kilocode_users.id, realUserIds));

  // Group rows by user ID and pick the best row
  const grouped = new Map<
    string,
    {
      google_user_name: string;
      google_user_image_url: string;
      display_name: string | null;
      avatar_url: string | null;
      created_at: string | null;
    }[]
  >();

  for (const row of rows) {
    if (!grouped.has(row.id)) {
      grouped.set(row.id, []);
    }
    grouped.get(row.id)?.push({
      google_user_name: row.google_user_name,
      google_user_image_url: row.google_user_image_url,
      display_name: row.display_name ?? null,
      avatar_url: row.avatar_url ?? null,
      created_at: row.created_at ?? null,
    });
  }

  for (const userId of realUserIds) {
    const userRows = grouped.get(userId);
    if (!userRows || userRows.length === 0) {
      result.set(userId, { displayName: null, avatarUrl: null });
      continue;
    }

    // Sort rows by created_at descending (most recent first)
    const sorted = [...userRows].sort((a, b) => {
      if (a.created_at === null && b.created_at === null) return 0;
      if (a.created_at === null) return 1;
      if (b.created_at === null) return -1;
      return b.created_at.localeCompare(a.created_at);
    });

    // Pick the most recent row with a non-null display_name
    const bestWithDisplayName = sorted.find(r => r.display_name !== null);
    // Fall back to the most recent row overall (sorted[0])
    const mostRecent = sorted[0];

    const chosenRow = bestWithDisplayName ?? mostRecent;
    const fallbackRow = mostRecent;

    const displayName = chosenRow.display_name ?? fallbackRow.google_user_name ?? null;
    const avatarUrl = chosenRow.avatar_url ?? fallbackRow.google_user_image_url ?? null;

    result.set(userId, { displayName, avatarUrl });
  }

  return result;
}

/**
 * Batch-queries kilocode_users to confirm which IDs exist.
 * Returns { valid: string[]; invalid: string[] }.
 *
 * Note: This does not handle bot IDs (prefix `bot:`). Callers should only
 * pass human user IDs — bot IDs will be reported as invalid since they don't
 * exist in the kilocode_users table.
 */
export async function validateUserIds(
  connectionString: string,
  userIds: string[]
): Promise<{ valid: string[]; invalid: string[] }> {
  if (userIds.length === 0) {
    return { valid: [], invalid: [] };
  }

  const db = getWorkerDb(connectionString);

  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, userIds));

  const foundIds = new Set(rows.map(r => r.id));
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const id of userIds) {
    if (foundIds.has(id)) {
      valid.push(id);
    } else {
      invalid.push(id);
    }
  }

  return { valid, invalid };
}
