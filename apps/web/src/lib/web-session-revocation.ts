import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

export function isWebSessionCurrent(
  sessionVersion: number | null | undefined,
  user: Pick<User, 'web_session_version'>
): boolean {
  const effectiveSessionVersion = sessionVersion ?? 0;
  return effectiveSessionVersion === user.web_session_version;
}

export async function revokeWebSession(
  kiloUserId: User['id'],
  fromDb: typeof db | DrizzleTransaction = db
) {
  await fromDb
    .update(kilocode_users)
    .set({ web_session_version: sql`${kilocode_users.web_session_version} + 1` })
    .where(eq(kilocode_users.id, kiloUserId));
}
