jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-preview-test-secret',
}));

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { POST } from './route';

const auth = jest.mocked(getUserFromAuth);

beforeEach(() => {
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development' });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it.each<NodeJS.ProcessEnv['NODE_ENV']>(['production', 'test'])(
  'denies preview credentials when NODE_ENV is %s',
  async environment => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: environment });

    const response = await POST();

    expect(response.status).toBe(403);
  }
);

it('requires authentication in development', async () => {
  auth.mockResolvedValue({
    user: null,
    authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
  });

  const response = await POST();

  expect(response.status).toBe(401);
  expect(
    z.strictObject({ success: z.literal(false), error: z.string() }).parse(await response.json())
  ).toEqual({ success: false, error: 'Unauthorized' });
});

it('issues a scoped short-lived development credential for the authenticated user', async () => {
  const user = defineTestUser();
  auth.mockResolvedValue({ user, authFailedResponse: null });

  const response = await POST();
  const body = z
    .object({ token: z.string(), expiresAt: z.iso.datetime() })
    .parse(await response.json());
  const credential = await verifyKiloTokenForPolicy(body.token, 'synthetic-preview-test-secret', {
    audience: KILO_API_AUDIENCE,
    mode: 'allow-legacy',
  });

  expect(credential.userId).toBe(user.id);
  expect(credential.claims).toMatchObject({
    aud: KILO_API_AUDIENCE,
    env: 'development',
    tokenPurpose: 'human-api',
    credentialExchange: false,
  });
  expect(credential.claims.exp - credential.claims.iat).toBe(300);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
