import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { extractBearerToken } from './extract-bearer-token.js';
import { verifyKiloToken, type KiloTokenPayload } from './kilo-token.js';
import { resError } from './res.js';

/**
 * A Cloudflare Secrets Store binding (production) or a plain string
 * (test/local env vars). Structural so worker-utils does not need to pull in
 * `@cloudflare/workers-types`.
 */
export type SecretBinding = { get(): Promise<string> } | string;

export type KiloAuthOrgMembership = {
  orgId: string;
  role: 'owner' | 'member' | 'billing_manager';
};

export type KiloAuthVariables = {
  kiloUserId: string;
  kiloIsAdmin: boolean;
  kiloApiTokenPepper: string | null;
  kiloGastownAccess: boolean;
  kiloOrgMemberships: KiloAuthOrgMembership[];
};

export type ResolveSecret = (binding: SecretBinding) => Promise<string | null>;

export type KiloAuthMiddlewareOptions = {
  resolveSecret: ResolveSecret;
  onAuthenticated?: (payload: KiloTokenPayload) => void;
};

export type KiloAuthEnv = {
  Bindings: { NEXTAUTH_SECRET?: SecretBinding | undefined };
  Variables: KiloAuthVariables;
};

/**
 * Hono middleware that validates Kilo user JWTs (HS256, signed with
 * NEXTAUTH_SECRET) for dashboard/user-facing routes.
 *
 * Sets the `kiloUserId`, `kiloIsAdmin`, `kiloApiTokenPepper`,
 * `kiloGastownAccess`, and `kiloOrgMemberships` variables on the Hono context.
 *
 * The secret is resolved via the injected `resolveSecret` so each service can
 * keep its own Secrets Store handling (and test string fallback). The optional
 * `onAuthenticated` hook lets a service tag its structured logger with the
 * authenticated user id.
 */
export function createKiloAuthMiddleware<E extends KiloAuthEnv>(
  options: KiloAuthMiddlewareOptions
): MiddlewareHandler<E> {
  const { resolveSecret, onAuthenticated } = options;
  return createMiddleware<E>(async (c, next) => {
    const token = extractBearerToken(c.req.header('Authorization'));

    if (!token) {
      return c.json(resError('Authentication required'), 401);
    }

    if (!c.env.NEXTAUTH_SECRET) {
      console.error('[kilo-auth] NEXTAUTH_SECRET not configured');
      return c.json(resError('Internal server error'), 500);
    }
    const secret = await resolveSecret(c.env.NEXTAUTH_SECRET);
    if (!secret) {
      console.error('[kilo-auth] failed to resolve NEXTAUTH_SECRET from Secrets Store');
      return c.json(resError('Internal server error'), 500);
    }

    try {
      const payload = await verifyKiloToken(token, secret);
      c.set('kiloUserId', payload.kiloUserId);
      c.set('kiloIsAdmin', payload.isAdmin === true);
      c.set('kiloApiTokenPepper', payload.apiTokenPepper ?? null);
      c.set('kiloGastownAccess', payload.gastownAccess === true);
      c.set('kiloOrgMemberships', payload.orgMemberships ?? []);
      onAuthenticated?.(payload);
    } catch (err) {
      console.warn(
        '[kilo-auth] token verification failed:',
        err instanceof Error ? err.message : 'unknown error'
      );
      return c.json(resError('Invalid token'), 401);
    }

    return next();
  });
}
