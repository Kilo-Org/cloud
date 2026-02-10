import { createMiddleware } from 'hono/factory';
import jwt from 'jsonwebtoken';

import type { Env } from '../env';

type TokenPayloadV3 = {
  kiloUserId: string;
  version: number;
};

function isTokenPayloadV3(payload: unknown): payload is TokenPayloadV3 {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const p = payload as Record<string, unknown>;
  return typeof p.kiloUserId === 'string' && p.kiloUserId.length > 0 && p.version === 3;
}

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? c.req.header('authorization');
  if (!authHeader) {
    return c.json({ success: false, error: 'Missing Authorization header' }, 401);
  }

  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return c.json({ success: false, error: 'Invalid Authorization header format' }, 401);
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return c.json({ success: false, error: 'Missing token' }, 401);
  }

  const secret = await c.env.NEXTAUTH_SECRET_PROD.get();

  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!isTokenPayloadV3(payload)) {
      return c.json({ success: false, error: 'Invalid token payload' }, 401);
    }

    c.set('user_id', payload.kiloUserId);
    await next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return c.json({ success: false, error: 'Token expired' }, 401);
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return c.json({ success: false, error: 'Invalid token signature' }, 401);
    }
    return c.json({ success: false, error: 'Token validation failed' }, 401);
  }
});
