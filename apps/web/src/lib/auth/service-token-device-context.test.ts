const mockHeaders = jest.fn<Promise<Headers>, []>();
const mockGetServerSession = jest.fn();

jest.mock('next/headers', () => ({ headers: () => mockHeaders(), cookies: jest.fn() }));
jest.mock('next-auth', () => ({
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock('@/lib/gastown/feature-flags', () => ({ isGastownEnabled: async () => true }));

import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { generateApiToken, validateAuthorizationHeader } from '@kilocode/web-shared/lib/tokens';
import { POST as mintGastownToken } from '@/app/api/gastown/token/route';
import { POST as mintWastelandToken } from '@/app/api/wasteland/token/route';
import jwt from 'jsonwebtoken';

describe.each([
  ['Gastown', mintGastownToken],
  ['Wasteland', mintWastelandToken],
])('%s service token context', (_service, mintToken) => {
  beforeEach(() => {
    mockHeaders.mockReset();
    mockGetServerSession.mockReset();
  });

  test('retains the active device context through token minting and checks it again', async () => {
    const user = await insertTestUser({ api_token_pepper: 'service-device-pepper' });
    const [session] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: user.id })
      .returning({ id: device_sessions.id });
    const source = generateApiToken(user, { deviceSessionId: session.id });
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${source}` }));

    const response = await mintToken();
    expect(response.status).toBe(200);
    const body: { token: string } = await response.json();
    const result = validateAuthorizationHeader(
      new Headers({ Authorization: `Bearer ${body.token}` })
    );
    expect(result).toMatchObject({ kiloUserId: user.id, deviceSessionId: session.id });
    const claims = jwt.decode(body.token);
    expect(claims).toEqual(
      expect.objectContaining({ exp: expect.any(Number), iat: expect.any(Number) })
    );
    if (
      !claims ||
      typeof claims === 'string' ||
      typeof claims.exp !== 'number' ||
      typeof claims.iat !== 'number'
    ) {
      throw new Error('Expected token lifetime claims');
    }
    expect(claims.exp - claims.iat).toBe(3600);

    await db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(device_sessions.id, session.id));
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${body.token}` }));
    const retry = await mintToken();
    expect(retry.status).toBe(401);
  });

  test.each(['api', 'cookie'])(
    'preserves %s authentication without a device claim',
    async source => {
      const user = await insertTestUser({
        api_token_pepper: 'service-personal-pepper',
        web_session_pepper: 'service-cookie-pepper',
      });
      mockHeaders.mockResolvedValue(
        source === 'api'
          ? new Headers({ Authorization: `Bearer ${generateApiToken(user)}` })
          : new Headers()
      );
      mockGetServerSession.mockResolvedValue({
        kiloUserId: user.id,
        webSessionPepper: user.web_session_pepper,
      });

      const response = await mintToken();
      expect(response.status).toBe(200);
      const body: { token: string } = await response.json();
      const result = validateAuthorizationHeader(
        new Headers({ Authorization: `Bearer ${body.token}` })
      );
      expect(result).toMatchObject({ kiloUserId: user.id });
      expect(result.deviceSessionId).toBeUndefined();
    }
  );
});
