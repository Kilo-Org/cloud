import { db, type DrizzleConnection } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import { newPepperRotation } from '@kilocode/web-shared/lib/auth/pepper-rotation';

export function isWebSessionCurrent(
  sessionPepper: string | null | undefined,
  user: Pick<User, 'web_session_pepper'>
): boolean {
  return (sessionPepper ?? null) === (user.web_session_pepper ?? null);
}

/**
 * Read the account's current web-session pepper from the primary. `revokeWebSessions`
 * commits the pepper on the primary and that write is the authoritative revocation, so a
 * session-validity decision must not take the value from a replica that may lag behind it.
 */
export async function readWebSessionPepper(kiloUserId: User['id']): Promise<string | null> {
  const [row] = await db
    .select({ web_session_pepper: kilocode_users.web_session_pepper })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, kiloUserId))
    .limit(1);
  return row?.web_session_pepper ?? null;
}

/** The account a revocation signed out, read from the revoking update itself. */
export type WebSessionRevocation = {
  user: Pick<User, 'id' | 'google_user_email'>;
  /** Identifies this revocation without revealing the pepper it installed. */
  rotationId: string;
};

/** Rotates the web-session pepper; resolves null when no such user exists. */
export async function revokeWebSessions(
  kiloUserId: User['id'],
  fromDb: DrizzleConnection = db
): Promise<WebSessionRevocation | null> {
  const rotation = newPepperRotation();
  const [user] = await fromDb
    .update(kilocode_users)
    .set({ web_session_pepper: rotation.pepper })
    .where(eq(kilocode_users.id, kiloUserId))
    .returning({ id: kilocode_users.id, google_user_email: kilocode_users.google_user_email });
  const revocation = user ? { user, rotationId: rotation.rotationId } : null;

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
    return revocation;
  }
  await revokeStepUpProofs(kiloUserId, 'session_revoked', fromDb);
  return revocation;
}
