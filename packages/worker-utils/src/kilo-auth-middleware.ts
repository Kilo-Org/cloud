import { decodeJwt, type JWTPayload } from 'jose';
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { deviceSessionIdSchema } from './device-session-claims';
import { extractBearerToken } from './extract-bearer-token.js';
import type { KiloTokenPayload } from './kilo-token.js';
import type { KiloResourceAudiencePolicy } from './kilo-token-policy.js';
import { verifyKiloTokenForPolicy, verifyKiloTokenForResource } from './kilo-token-policy.js';
import { resError } from './res.js';

/**
 * A Cloudflare Secrets Store binding (production) or a plain string
 * (test/local env vars). Structural so worker-utils does not need to pull in
 * `@cloudflare/workers-types`.
 */
export type SecretBinding = { get(): Promise<string> } | string;

export type KiloAuthOrgMembership = NonNullable<KiloTokenPayload['orgMemberships']>[number];

export type KiloAuthVariables = {
  kiloControlToken: string;
  kiloUsesModernToken: boolean;
  kiloTokenClaims: JWTPayload;
  kiloUserId: string;
  kiloIsAdmin: boolean;
  kiloApiTokenPepper: string | null;
  kiloGastownAccess: boolean;
  kiloOrgMemberships: KiloAuthOrgMembership[];
};

export type ResolveSecret = (binding: SecretBinding) => Promise<string | null>;

export type KiloAuthMiddlewareOptions<E extends KiloAuthEnv = KiloAuthEnv> = {
  resolveSecret: ResolveSecret;
  audiencePolicy: KiloResourceAudiencePolicy;
  onAuthenticated?: (payload: KiloTokenPayload) => void;
  /**
   * Validates a device session claim. When the option is omitted, tokens that
   * claim a device session are refused rather than accepted unchecked.
   */
  isActiveDeviceSession?: (
    env: E['Bindings'],
    deviceSessionId: string,
    userId: string
  ) => Promise<boolean>;
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
  options: KiloAuthMiddlewareOptions<E>
): MiddlewareHandler<E> {
  const { resolveSecret, audiencePolicy, onAuthenticated } = options;
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
      const payload = await verifyKiloTokenForResource(token, secret, audiencePolicy);
      // Preserve claims stripped by the legacy payload schema for downstream authorization.
      // Decode only after signature and resource audience verification succeeds.
      const claims = decodeJwt(token);
      const usesModernToken =
        claims.tokenPurpose !== undefined || claims.credentialExchange !== undefined;
      if (usesModernToken) {
        await verifyKiloTokenForPolicy(token, secret, audiencePolicy);
      }
      c.set('kiloControlToken', token);
      c.set('kiloUsesModernToken', usesModernToken);
      c.set('kiloTokenClaims', claims);
      c.set('kiloUserId', payload.kiloUserId);
      c.set('kiloIsAdmin', payload.isAdmin === true);
      c.set('kiloApiTokenPepper', payload.apiTokenPepper ?? null);
      c.set('kiloGastownAccess', payload.gastownAccess === true);
      c.set('kiloOrgMemberships', payload.orgMemberships ?? []);
      onAuthenticated?.(payload);

      if (payload.deviceSessionId !== undefined) {
        if (!deviceSessionIdSchema.safeParse(payload.deviceSessionId).success) {
          return c.json(resError('Invalid token'), 401);
        }
        if (!options.isActiveDeviceSession) {
          return c.json(resError('Invalid token'), 401);
        }
        let active: boolean;
        try {
          active = await options.isActiveDeviceSession(
            c.env,
            payload.deviceSessionId,
            payload.kiloUserId
          );
        } catch (err) {
          console.warn(
            '[kilo-auth] device session lookup failed:',
            err instanceof Error ? err.message : 'unknown error'
          );
          return c.json(resError('Service temporarily unavailable'), 503);
        }
        if (!active) {
          return c.json(resError('Invalid token'), 401);
        }
      }
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
