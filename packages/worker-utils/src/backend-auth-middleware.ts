import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bearerAuth } from 'hono/bearer-auth';

/**
 * Hono middleware that authenticates requests using a bearer token.
 *
 * @param getToken - Returns the expected token from the Hono context (e.g. `c => c.env.BACKEND_AUTH_TOKEN`)
 */
export function backendAuthMiddleware<E extends { Bindings: Record<never, never> }>(
  getToken: (c: Context<E>) => string | undefined
): MiddlewareHandler<E> {
  return async (c, next) => {
    const authToken = getToken(c);

    if (!authToken || authToken.trim() === '') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const auth = bearerAuth({ token: authToken });
    try {
      return await auth(c, next);
    } catch (error) {
      if (error instanceof HTTPException) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      throw error;
    }
  };
}
