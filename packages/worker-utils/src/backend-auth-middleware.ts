import type { Context, MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from './extract-bearer-token.js';

type MaybePromise<T> = T | Promise<T>;

/**
 * Hono middleware that authenticates requests using a bearer token.
 *
 * @param getToken - Returns the expected token from the Hono context (e.g. `c => c.env.BACKEND_AUTH_TOKEN`)
 */
export function backendAuthMiddleware<E extends { Bindings: Record<never, never> }>(
  getToken: (c: Context<E>) => MaybePromise<string | undefined>
): MiddlewareHandler<E> {
  return async (c, next) => {
    const authToken = await getToken(c);

    if (!authToken || authToken.trim() === '') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const bearerToken = extractBearerToken(c.req.header('authorization'));
    if (!bearerToken || !timingSafeEqual(bearerToken, authToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return next();
  };
}
