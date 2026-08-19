import type { WorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

type UserSessionAdmissionDb = Pick<WorkerDb, 'select'>;

/**
 * Check the user row under the caller's transaction lock immediately before
 * creating a cli_sessions_v2 row.
 */
export async function canCreateCliSessionForUser(
  db: UserSessionAdmissionDb,
  kiloUserId: string
): Promise<boolean> {
  const [user] = await db
    .select({ blocked_reason: kilocode_users.blocked_reason })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, kiloUserId))
    .limit(1)
    .for('update');

  return user?.blocked_reason === null;
}

export const USER_SESSION_ADMISSION_ERROR = 'User session creation is not allowed';
