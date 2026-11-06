jest.mock('server-only', () => ({}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/worker-utils/kilo-token-policy', () => ({
  signModernKiloToken: jest.fn(async () => ({
    token: 'short-token',
    expiresAt: '2026-11-05T10:05:00.000Z',
  })),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-signing-secret',
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { POST } from './route';

const auth = jest.mocked(getUserFromAuth);
const generate = jest.mocked(signModernKiloToken);

afterEach(() => jest.clearAllMocks());
it('preserves failed authentication without minting a credential', async () => {
  const denied = new Response('Unauthorized', { status: 401 });
  auth.mockResolvedValue({ user: null, authFailedResponse: denied } as Awaited<
    ReturnType<typeof getUserFromAuth>
  >);
  expect(await POST()).toBe(denied);
  expect(generate).not.toHaveBeenCalled();
});
it('mints a five-minute non-chat credential without a feature gate', async () => {
  const user = { id: 'creator', api_token_pepper: 'pepper' };
  auth.mockResolvedValue({ user, authFailedResponse: null } as Awaited<
    ReturnType<typeof getUserFromAuth>
  >);
  const response = await POST();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    token: 'short-token',
    expiresAt: '2026-11-05T10:05:00.000Z',
  });
  expect(generate).toHaveBeenCalledWith({
    userId: 'creator',
    pepper: 'pepper',
    secret: 'synthetic-signing-secret',
    env: 'test',
    audience: KILO_API_AUDIENCE,
    tokenPurpose: 'human-api',
    credentialExchange: false,
    expiresInSeconds: 300,
  });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
