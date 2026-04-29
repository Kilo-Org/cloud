import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

let testUser: User;

describe('kiloChat router - getToken', () => {
  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: `kilo-chat-token-${crypto.randomUUID()}@example.com`,
      google_user_name: 'Kilo Chat Token Test User',
    });
  });

  it('returns a JWT-shaped token and a future expiresAt', async () => {
    const caller = await createCallerForUser(testUser.id);
    const before = Date.now();
    const result = await caller.kiloChat.getToken();

    expect(result.token).toMatch(/\..+\..+/);

    const expiresAtMs = Date.parse(result.expiresAt);
    expect(Number.isNaN(expiresAtMs)).toBe(false);
    expect(expiresAtMs).toBeGreaterThan(before);
  });
});
