import { createMiddleware } from 'hono/factory';
import { verifyKiloToken, extractBearerToken } from '@kilocode/worker-utils';
import { findKiloUserPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { z } from 'zod';

import type { Env } from '../env';

export const USER_AUTH_CACHE_KEY_PREFIX = 'user-auth:v1:';
const USER_AUTH_TTL_SECONDS = 60;
const USER_MISSING_TTL_SECONDS = 5 * 60;

type CachedUserAuthV1 =
  | { v: 1; exists: false }
  | { v: 1; exists: true; pepper: string | null; blockedReason: string | null };

const cachedUserAuthV1Schema = z.union([
  z.object({ v: z.literal(1), exists: z.literal(false) }).strict(),
  z
    .object({
      v: z.literal(1),
      exists: z.literal(true),
      pepper: z.string().nullable(),
      blockedReason: z.string().nullable(),
    })
    .strict(),
]);

const USER_AUTH_DENIED = 'User account not found';

function parseCachedUserAuth(raw: string | null): CachedUserAuthV1 | null {
  if (raw === null) return null;
  try {
    const parsed = cachedUserAuthV1Schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function loadUserAuth(env: Env, userId: string): Promise<CachedUserAuthV1> {
  const cacheKey = `${USER_AUTH_CACHE_KEY_PREFIX}${userId}`;
  const cached = parseCachedUserAuth(await env.USER_EXISTS_CACHE.get(cacheKey));
  if (cached) return cached;

  const row = await findKiloUserPepper(env.HYPERDRIVE.connectionString, userId);
  const state: CachedUserAuthV1 =
    row === undefined || row === null
      ? { v: 1, exists: false }
      : { v: 1, exists: true, pepper: row.pepper, blockedReason: row.blockedReason };

  try {
    await env.USER_EXISTS_CACHE.put(cacheKey, JSON.stringify(state), {
      expirationTtl: state.exists ? USER_AUTH_TTL_SECONDS : USER_MISSING_TTL_SECONDS,
    });
  } catch (error) {
    console.warn('Failed to cache user auth state', {
      operation: 'user-auth-cache-put',
      kiloUserId: userId,
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  return state;
}

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  let token = extractBearerToken(c.req.header('Authorization'));
  if (!token && c.req.header('Upgrade') === 'websocket') {
    token = c.req.query('token') ?? null;
  }

  if (!token) {
    return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
  }

  let secret: string;
  try {
    const configuredSecret = await c.env.NEXTAUTH_SECRET_PROD.get();
    if (!configuredSecret) {
      console.error('Auth infrastructure failure', { operation: 'nextauth-secret-missing' });
      return c.json({ success: false, error: 'Service temporarily unavailable' }, 503);
    }
    secret = configuredSecret;
  } catch (error) {
    console.error('Auth infrastructure failure', {
      operation: 'nextauth-secret-get',
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return c.json({ success: false, error: 'Service temporarily unavailable' }, 503);
  }

  let kiloUserId: string;
  let apiTokenPepper: string | null | undefined;
  try {
    const payload = await verifyKiloToken(token, secret);
    kiloUserId = payload.kiloUserId;
    apiTokenPepper = payload.apiTokenPepper;
  } catch {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  let state: CachedUserAuthV1;
  try {
    state = await loadUserAuth(c.env, kiloUserId);
  } catch (error) {
    console.error('Auth infrastructure failure', {
      operation: 'user-auth-load',
      kiloUserId,
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return c.json({ success: false, error: 'Service temporarily unavailable' }, 503);
  }

  if (!state.exists) {
    return c.json({ success: false, error: USER_AUTH_DENIED }, 403);
  }

  // A missing apiTokenPepper is the legacy internal service-token class. It
  // intentionally requires only an existing user; ordinary tokens carry a
  // pepper (including null) and must pass the blocked/pepper checks below.
  if (apiTokenPepper === undefined) {
    c.set('user_id', kiloUserId);
    return next();
  }

  if (state.blockedReason !== null || state.pepper !== apiTokenPepper) {
    return c.json({ success: false, error: USER_AUTH_DENIED }, 403);
  }

  c.set('user_id', kiloUserId);
  return next();
});
