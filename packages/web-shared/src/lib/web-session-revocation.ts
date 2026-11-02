import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';

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

  // Every proof is bound to a session that is now invalid. Revoking in the
  // same write keeps a concurrent guard from reading a live proof after the
  // pepper changed.
  await revokeStepUpProofs(kiloUserId, 'session_revoked', fromDb);
}
