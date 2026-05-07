import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

export function isWebSessionCurrent(
  sessionPepper: string | null | undefined,
  user: Pick<User, 'web_session_pepper'>
): boolean {
  return (sessionPepper ?? null) === (user.web_session_pepper ?? null);
}

export async function revokeWebSessions(
  kiloUserId: User['id'],
  fromDb: typeof db | DrizzleTransaction = db
): Promise<void> {
  await fromDb
    .update(kilocode_users)
    .set({ web_session_pepper: randomUUID() })
    .where(eq(kilocode_users.id, kiloUserId));
}
