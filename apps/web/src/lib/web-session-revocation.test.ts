import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { isWebSessionCurrent, revokeWebSession } from '@/lib/web-session-revocation';


describe('web session revocation', () => {
  afterEach(async () => {
    await db.delete(kilocode_users).where(sql`${kilocode_users.id} LIKE 'test-user-%'`);
  });

  it('accepts only matching web session versions', () => {
    expect(isWebSessionCurrent(3, { web_session_version: 3 })).toBe(true);
    expect(isWebSessionCurrent(2, { web_session_version: 3 })).toBe(false);
    expect(isWebSessionCurrent(undefined, { web_session_version: 3 })).toBe(false);
  });

  it('increments web_session_version without rotating api_token_pepper', async () => {
    const user = await insertTestUser({ api_token_pepper: 'pepper', web_session_version: 4 });

    await revokeWebSession(user.id);

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });

    expect(updated?.web_session_version).toBe(5);
    expect(updated?.api_token_pepper).toBe('pepper');
  });
});
