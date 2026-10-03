import { db } from '@/lib/drizzle';
import { isWebSessionCurrent, revokeWebSessions } from '@/lib/web-session-revocation';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

describe('web session revocation', () => {
  afterEach(async () => {
    await db.delete(kilocode_users).where(sql`${kilocode_users.id} LIKE 'test-user-%'`);
  });

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
