import { Hono } from 'hono';
import { SignJWT } from 'jose';

import { kiloJwtAuthMiddleware } from './kilo-jwt-auth';

type TestEnv = {
  NEXTAUTH_SECRET_PROD: {
    get: () => Promise<string>;
  };
  USER_EXISTS_CACHE: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, options?: { expirationTtl: number }) => Promise<void>;
  };
  HYPERDRIVE: {
    connectionString: string;
  };
};

function makeEnv(secret: string, opts?: { cachedUserState?: '1' | '0' | null }): TestEnv {
  return {
    NEXTAUTH_SECRET_PROD: {
      get: async () => secret,
    },
    USER_EXISTS_CACHE: {
      get: async () => opts?.cachedUserState ?? null,
      put: async () => {},
    },
    // Not used when the KV cache returns a hit.
    HYPERDRIVE: { connectionString: '' },
  };
}

async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

describe('kiloJwtAuthMiddleware', () => {
  it('rejects missing Authorization header', async () => {
    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(new Request('http://local/api/me'), makeEnv('secret'));
    expect(res.status).toBe(401);
  });

  it('accepts valid v3 token when user exists in cache', async () => {
    const secret = 'test-secret';
    const token = await sign({ kiloUserId: 'usr_123', version: 3 }, secret);

    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(
      new Request('http://local/api/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      makeEnv(secret, { cachedUserState: '1' })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('rejects valid v3 token when user is cached as not-found', async () => {
    const secret = 'test-secret';
    const token = await sign({ kiloUserId: 'deleted_user', version: 3 }, secret);

    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(
      new Request('http://local/api/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      makeEnv(secret, { cachedUserState: '0' })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: 'User account not found' });
  });
});
