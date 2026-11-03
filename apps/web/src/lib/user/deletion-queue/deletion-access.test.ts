import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { kilocode_users, passkey_credentials, session_step_up_proofs } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { disableUserAccessForDeletion } from './deletion-access';

describe('disableUserAccessForDeletion', () => {
  it('revokes live step-up proofs and closes the account', async () => {
    const user = await insertTestUser();
    const actor = await insertTestUser({ is_admin: true });
    const [credential] = await db
      .insert(passkey_credentials)
      .values({
        kilo_user_id: user.id,
        credential_id: `deletion-credential-${crypto.randomUUID()}`,
        public_key: 'unused',
      })
      .returning();
    const [proof] = await db
      .insert(session_step_up_proofs)
      .values({
        kilo_user_id: user.id,
        session_id_hash: hashWebSessionId('deletion-session'),
        method: 'webauthn_uv',
        passkey_credential_id: credential!.id,
        purpose: 'session',
        verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
      .returning();
    const nowIso = new Date().toISOString();

    await db.transaction(tx =>
      disableUserAccessForDeletion(tx, {
        userId: user.id,
        requestedByKiloUserId: actor.id,
        nowIso,
      })
    );

    const [blocked] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(blocked?.blocked_reason).toContain('deletion');

    const [revoked] = await db
      .select()
      .from(session_step_up_proofs)
      .where(eq(session_step_up_proofs.id, proof!.id));
    expect(revoked?.revoked_reason).toBe('deletion');
    expect(revoked?.revoked_at).not.toBeNull();
  });
});
