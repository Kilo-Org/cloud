import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';

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

  // Every proof is bound to a session that is now invalid. The pepper update is
  // the authoritative revocation; the proof rows are cleared afterwards, not
  // atomically with it. On the primary, a missing 0325 table must not make
  // sign-out fail, so this write is best-effort. A caller-supplied transaction
  // keeps normal error propagation because a failed statement would abort it.
  if (fromDb === db) {
    try {
      await revokeStepUpProofs(kiloUserId, 'session_revoked', fromDb);
    } catch (error) {
      reportStepUpFailure('revoke_web_sessions_step_up', error);
    }
    return;
  }
  await revokeStepUpProofs(kiloUserId, 'session_revoked', fromDb);
}
