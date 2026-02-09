import { Hono } from 'hono';
import jwt from 'jsonwebtoken';

import { kiloJwtAuthMiddleware } from './kilo-jwt-auth';

type TestEnv = {
  NEXTAUTH_SECRET_PROD: {
    get: () => Promise<string>;
  };
};

function makeEnv(secret: string): TestEnv {
  return {
    NEXTAUTH_SECRET_PROD: {
      get: async () => secret,
    },
  };
}

describe('kiloJwtAuthMiddleware', () => {
  it('rejects missing Authorization header', async () => {
    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(new Request('http://local/api/me'), makeEnv('secret'));
    expect(res.status).toBe(401);
  });

  it('accepts valid v3 token and sets user_id', async () => {
    const secret = 'test-secret';
    const token = jwt.sign({ kiloUserId: 'usr_123', version: 3 }, secret, { algorithm: 'HS256' });

    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(
      new Request('http://local/api/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      makeEnv(secret)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });
});
