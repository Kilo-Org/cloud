import { db } from '@/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

export function isWebSessionCurrent(
  sessionVersion: number | null | undefined,
  user: Pick<User, 'web_session_version'>
): boolean {
  return typeof sessionVersion === 'number' && sessionVersion === user.web_session_version;
}

export async function revokeWebSession(kiloUserId: User['id'], fromDb: typeof db = db) {
  await fromDb
    .update(kilocode_users)
    .set({ web_session_version: sql`${kilocode_users.web_session_version} + 1` })
    .where(eq(kilocode_users.id, kiloUserId));
}
