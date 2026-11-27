import type { Context, MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from './extract-bearer-token.js';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from './internal-auth-observation.js';

type MaybePromise<T> = T | Promise<T>;

/** Where an accepted request is reported (design section 9.4, item 9). */
export type BackendAuthObservation<E extends { Bindings: Record<never, never> }> = {
  /** The receiving surface, one of `INTERNAL_CALLERS`. */
  receiver: string;
  /**
   * The route family of an accepted request: a literal, or a bounded function of the context when
   * one middleware guards several families.
   */
  route: string | ((c: Context<E>) => string);
};

/**
 * Hono middleware that authenticates requests using a bearer token.
 *
 * @param getToken - Returns the expected token from the Hono context (e.g. `c => c.env.BACKEND_AUTH_TOKEN`)
 * @param observation - Reports each accepted request for the item-9 counter; omit to write nothing
 */
export function backendAuthMiddleware<E extends { Bindings: Record<never, never> }>(
  getToken: (c: Context<E>) => MaybePromise<string | undefined>,
  observation?: BackendAuthObservation<E>
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

    if (observation !== undefined) {
      observeInternalAuth(
        observation.receiver,
        typeof observation.route === 'string' ? observation.route : observation.route(c),
        'legacy_shared_secret',
        callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
      );
    }

    return next();
  };
}
