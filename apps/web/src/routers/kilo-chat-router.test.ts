import jwt from 'jsonwebtoken';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { JWT_TOKEN_VERSION } from '@/lib/tokens';
import type { User } from '@kilocode/db/schema';

let testUser: User;

describe('kiloChat router - getToken', () => {
  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: `kilo-chat-token-${crypto.randomUUID()}@example.com`,
      google_user_name: 'Kilo Chat Token Test User',
    });
  });

  it('returns a verifiable kilo-chat JWT for the caller, expiring in ~1h', async () => {
    const caller = await createCallerForUser(testUser.id);
    const before = Date.now();
    const result = await caller.kiloChat.getToken();
    const after = Date.now();

    const payload = jwt.verify(result.token, NEXTAUTH_SECRET, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload & { kiloUserId: string; tokenSource: string; version: number };

    expect(result.userId).toBe(testUser.id);
    expect(payload.kiloUserId).toBe(testUser.id);
    expect(payload.tokenSource).toBe('kilo-chat');
    expect(payload.version).toBe(JWT_TOKEN_VERSION);

    const expiresAtMs = Date.parse(result.expiresAt);
    expect(Number.isNaN(expiresAtMs)).toBe(false);
    // Router uses a 1h TTL; allow ±5s of clock slop around the call window.
    const oneHourMs = 60 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + oneHourMs - 5_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + oneHourMs + 5_000);
  });
});
