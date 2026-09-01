import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createKiloAuthMiddleware } from './kilo-auth-middleware';

const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const resolveSecret = async (binding: { get(): Promise<string> } | string) =>
  typeof binding === 'string' ? binding : await binding.get();

type TestEnv = {
  Bindings: { NEXTAUTH_SECRET?: string };
  Variables: {
    kiloUserId: string;
    kiloIsAdmin: boolean;
    kiloApiTokenPepper: string | null;
    kiloGastownAccess: boolean;
    kiloOrgMemberships: { orgId: string; role: 'owner' | 'member' | 'billing_manager' }[];
  };
};

function createApp() {
  const app = new Hono<TestEnv>();
  app.use('/api/*', createKiloAuthMiddleware<TestEnv>({ resolveSecret }));
  app.get('/api/whoami', c => {
    return c.json({
      kiloUserId: c.get('kiloUserId'),
      kiloGastownAccess: c.get('kiloGastownAccess'),
    });
  });
  return app;
}

async function signToken(payload: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

describe('createKiloAuthMiddleware', () => {
  it('rejects when no token is provided', async () => {
    const app = createApp();
    const res = await app.request('/api/whoami', {}, {
      NEXTAUTH_SECRET: TEST_SECRET,
    } as never);
    expect(res.status).toBe(401);
  });

  it('accepts a well-formed Kilo token and sets the auth context', async () => {
    const app = createApp();
    const token = await signToken({
      version: 3,
      kiloUserId: 'user-abc',
      gastownAccess: true,
      env: 'development',
    });

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      { NEXTAUTH_SECRET: TEST_SECRET } as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kiloUserId: string; kiloGastownAccess: boolean };
    expect(body.kiloUserId).toBe('user-abc');
    expect(body.kiloGastownAccess).toBe(true);
  });

  it('accepts a token carrying a deviceSessionId claim', async () => {
    const app = createApp();
    const token = await signToken({
      version: 3,
      kiloUserId: 'user-abc',
      apiTokenPepper: null,
      env: 'development',
      deviceSessionId: 'session-gastown-test',
    });

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      { NEXTAUTH_SECRET: TEST_SECRET } as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kiloUserId: string };
    expect(body.kiloUserId).toBe('user-abc');
  });
});
