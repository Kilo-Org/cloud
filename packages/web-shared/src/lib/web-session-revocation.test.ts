import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  isWebSessionCurrent,
  revokeWebSessions,
} from '@kilocode/web-shared/lib/web-session-revocation';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { kilocode_users, passkey_credentials, session_step_up_proofs } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';

describe('web session revocation', () => {
  afterEach(async () => {
    await db.delete(kilocode_users).where(sql`${kilocode_users.id} LIKE 'test-user-%'`);
  });

  async function insertProof(userId: string) {
    const [credential] = await db
      .insert(passkey_credentials)
      .values({
        kilo_user_id: userId,
        credential_id: `revocation-credential-${crypto.randomUUID()}`,
        public_key: 'unused',
      })
      .returning();
    const [proof] = await db
      .insert(session_step_up_proofs)
      .values({
        kilo_user_id: userId,
        session_id_hash: hashWebSessionId('revocation-session'),
        method: 'webauthn_uv',
        passkey_credential_id: credential!.id,
        purpose: 'session',
        verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
      .returning();
    return proof!;
  }

  it('accepts legacy sessions while the user has no web session pepper', () => {
    expect(isWebSessionCurrent(undefined, { web_session_pepper: null })).toBe(true);
    expect(isWebSessionCurrent(null, { web_session_pepper: null })).toBe(true);
  });

  it('accepts only matching web session peppers once set', () => {
    expect(isWebSessionCurrent('pepper-2', { web_session_pepper: 'pepper-2' })).toBe(true);
    expect(isWebSessionCurrent('pepper-1', { web_session_pepper: 'pepper-2' })).toBe(false);
    expect(isWebSessionCurrent(undefined, { web_session_pepper: 'pepper-2' })).toBe(false);
    expect(isWebSessionCurrent(null, { web_session_pepper: 'pepper-2' })).toBe(false);
  });

  it('rotates web_session_pepper without rotating api_token_pepper', async () => {
    const user = await insertTestUser({ api_token_pepper: 'api-pepper' });

    await revokeWebSessions(user.id);

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });

    if (!updated) throw new Error('Expected test user to exist after revoking web sessions');

    expect(updated.web_session_pepper).toEqual(expect.any(String));
    expect(updated.web_session_pepper).not.toBe(user.web_session_pepper);
    expect(updated.api_token_pepper).toBe('api-pepper');
  });

  it('revokes every live step-up proof in the same call', async () => {
    const user = await insertTestUser();
    const proof = await insertProof(user.id);

    await revokeWebSessions(user.id);

    const [stored] = await db
      .select()
      .from(session_step_up_proofs)
      .where(eq(session_step_up_proofs.id, proof.id));
    expect(stored?.revoked_at).not.toBeNull();
    expect(stored?.revoked_reason).toBe('session_revoked');
  });

  it('can rotate web_session_pepper in a transaction', async () => {
    const user = await insertTestUser({ web_session_pepper: 'old-web-pepper' });

    await db.transaction(async tx => {
      await revokeWebSessions(user.id, tx);
    });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });

    if (!updated) throw new Error('Expected test user to exist after transactional revocation');

    expect(updated.web_session_pepper).toEqual(expect.any(String));
    expect(updated.web_session_pepper).not.toBe('old-web-pepper');
  });
});
