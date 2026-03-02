import { createMiddleware } from 'hono/factory';
import { verifyKiloToken, extractBearerToken } from '@kilocode/worker-utils';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';

import type { Env } from '../env';

const USER_EXISTS_TTL_SECONDS = 24 * 60 * 60; // 24h
const USER_NOT_FOUND_TTL_SECONDS = 5 * 60; // 5m

/**
 * Check whether a user exists, using KV as a cache in front of Postgres.
 * Positive results are cached for 24h. Negative results are cached for 5m
 * to rate-limit DB hits from deleted/nonexistent users with valid tokens.
 */
async function userExists(env: Env, userId: string): Promise<boolean> {
  const cacheKey = `user-exists:${userId}`;

  const cached = await env.USER_EXISTS_CACHE.get(cacheKey);
  if (cached === '1') {
    return true;
  }
  if (cached === '0') {
    return false;
  }

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  const row = rows[0];

  if (!row) {
    void env.USER_EXISTS_CACHE.put(cacheKey, '0', { expirationTtl: USER_NOT_FOUND_TTL_SECONDS });
    return false;
  }

  void env.USER_EXISTS_CACHE.put(cacheKey, '1', { expirationTtl: USER_EXISTS_TTL_SECONDS });
  return true;
}

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
  }

  const secret = await c.env.NEXTAUTH_SECRET_PROD.get();

  let kiloUserId: string;
  try {
    const payload = await verifyKiloToken(token, secret);
    kiloUserId = payload.kiloUserId;
  } catch {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  const exists = await userExists(c.env, kiloUserId);
  if (!exists) {
    return c.json({ success: false, error: 'User account not found' }, 403);
  }

  c.set('user_id', kiloUserId);
  return next();
});
