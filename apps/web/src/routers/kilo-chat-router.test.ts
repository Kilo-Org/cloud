import { describe, it, expect, beforeAll } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

describe('kiloChat router', () => {
  let user: User;

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'kilo-chat-token@example.com',
      google_user_name: 'KiloChat Token User',
    });
  });

  describe('getToken', () => {
    it('returns a non-empty token string', async () => {
      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloChat.getToken();
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(0);
    });

    it('returns an expiresAt timestamp in the future', async () => {
      const before = Date.now();
      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloChat.getToken();
      const expiresAtMs = new Date(result.expiresAt).getTime();
      expect(expiresAtMs).toBeGreaterThan(before);
      // Should be approximately 1 hour from now (within a few seconds of tolerance)
      expect(expiresAtMs).toBeLessThan(before + 60 * 60 * 1000 + 5000);
    });
  });
});
