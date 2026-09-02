import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { signKiloToken } from '@kilocode/worker-utils/kilo-token';
import { AI_ATTRIBUTION_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import type { HonoContext } from '../ai-attribution.worker';
import { authMiddleware, validateKiloToken } from './auth';

const TEST_SECRET = 'ai-attribution-test-secret';
const USER_ID = 'user-123';
const ORGANIZATION_ID = 'org-123';

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function signPayload(payload: Record<string, unknown>, secret = TEST_SECRET): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function policyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: 3,
    kiloUserId: USER_ID,
    organizationId: ORGANIZATION_ID,
    organizationRole: 'member',
    iat: now - 60,
    exp: now + 60,
    ...overrides,
  };
}

async function organizationToken(
  options: {
    audience?: string;
    organizationId?: string;
    organizationRole?: 'owner' | 'member' | 'billing_manager';
    expiresInSeconds?: number;
  } = {}
): Promise<string> {
  const { token } = await signKiloToken({
    userId: USER_ID,
    pepper: null,
    secret: TEST_SECRET,
    expiresInSeconds: options.expiresInSeconds ?? 60,
    audience: options.audience,
    extra: {
      organizationId: options.organizationId ?? ORGANIZATION_ID,
      organizationRole: options.organizationRole ?? 'member',
    },
  });
  return token;
}

function buildApp() {
  let downstreamCalls = 0;
  const app = new Hono<HonoContext>();
  app.use('*', authMiddleware);
  app.get('*', c => {
    downstreamCalls += 1;
    return c.json({
      reached: true,
      userId: c.get('user_id'),
      organizationId: c.get('organization_id'),
      organizationRole: c.get('organization_role'),
      token: c.get('token'),
    });
  });
  return { app, downstreamCalls: () => downstreamCalls };
}

describe('validateKiloToken', () => {
  it('accepts an audience-bound organization token and preserves the bearer token', async () => {
    const token = await organizationToken({ audience: AI_ATTRIBUTION_AUDIENCE });

    await expect(validateKiloToken(`Bearer ${token}`, TEST_SECRET)).resolves.toEqual({
      success: true,
      token,
      kiloUserId: USER_ID,
      organizationId: ORGANIZATION_ID,
      organizationRole: 'member',
    });
  });

  it('accepts a legacy organization token with no audience', async () => {
    const token = await organizationToken();

    await expect(validateKiloToken(`Bearer ${token}`, TEST_SECRET)).resolves.toMatchObject({
      success: true,
      organizationId: ORGANIZATION_ID,
    });
  });

  it('accepts a matching audience in an audience array', async () => {
    const token = signPayload(policyPayload({ aud: ['another-service', AI_ATTRIBUTION_AUDIENCE] }));

    await expect(validateKiloToken(`Bearer ${token}`, TEST_SECRET)).resolves.toMatchObject({
      success: true,
      token,
    });
  });

  it.each([
    ['mismatched audience', policyPayload({ aud: 'another-service' })],
    ['malformed empty audience', policyPayload({ aud: '' })],
    [
      'malformed duplicate audience array',
      policyPayload({ aud: [AI_ATTRIBUTION_AUDIENCE, AI_ATTRIBUTION_AUDIENCE] }),
    ],
    ['missing organization ID', policyPayload({ organizationId: undefined })],
    ['billing-manager organization role', policyPayload({ organizationRole: 'billing_manager' })],
    ['invalid organization role', policyPayload({ organizationRole: 'admin' })],
    ['unsupported token version', policyPayload({ version: 2 })],
    ['expired token', policyPayload({ iat: 1, exp: 2 })],
  ])('rejects a token with %s', async (_name, payload) => {
    const token = signPayload(payload);

    await expect(validateKiloToken(`Bearer ${token}`, TEST_SECRET)).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
  });

  it('accepts a legacy token without an audience, issue date, or expiry date', async () => {
    const token = signPayload(policyPayload({ iat: undefined, exp: undefined }));

    await expect(validateKiloToken(`Bearer ${token}`, TEST_SECRET)).resolves.toMatchObject({
      success: true,
      token,
    });
  });

  it('rejects invalid signatures and malformed authorization headers', async () => {
    const token = await organizationToken({ audience: AI_ATTRIBUTION_AUDIENCE });
    const invalidSignature = signPayload(
      policyPayload({ aud: AI_ATTRIBUTION_AUDIENCE }),
      'other-secret'
    );

    await expect(validateKiloToken(`Bearer ${invalidSignature}`, TEST_SECRET)).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
    await expect(validateKiloToken(token, TEST_SECRET)).resolves.toEqual({
      success: false,
      error: 'Missing or malformed Authorization header',
    });
  });
});

describe('authMiddleware', () => {
  it('preserves server errors from the secret provider without calling downstream', async () => {
    const { app, downstreamCalls } = buildApp();
    const token = await organizationToken({ audience: AI_ATTRIBUTION_AUDIENCE });
    const env = {
      NEXTAUTH_SECRET: {
        get: async (): Promise<string> => {
          throw new Error('test secret provider unavailable');
        },
      },
    } as Env;

    const response = await app.request(
      '/attributions/whoami',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );

    expect(response.status).toBe(500);
    expect(downstreamCalls()).toBe(0);
  });

  it('does not call the downstream handler for an invalid audience', async () => {
    const { app, downstreamCalls } = buildApp();
    const token = await organizationToken({ audience: 'another-service' });
    const env = { NEXTAUTH_SECRET: { get: async () => TEST_SECRET } } as Env;

    const response = await app.request(
      '/attributions/whoami',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );

    expect(response.status).toBe(401);
    expect(downstreamCalls()).toBe(0);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
  });

  it('sets the existing user and organization contexts for a valid token', async () => {
    const { app, downstreamCalls } = buildApp();
    const token = await organizationToken({
      audience: AI_ATTRIBUTION_AUDIENCE,
      organizationRole: 'owner',
    });
    const env = { NEXTAUTH_SECRET: { get: async () => TEST_SECRET } } as Env;

    const response = await app.request(
      '/attributions/whoami',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(downstreamCalls()).toBe(1);
    await expect(response.json()).resolves.toEqual({
      reached: true,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      organizationRole: 'owner',
      token,
    });
  });
});
