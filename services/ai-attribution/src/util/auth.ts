import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { getWorkerDb } from '@kilocode/db/client';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { AI_ATTRIBUTION_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { verifyKiloTokenForResource } from '@kilocode/worker-utils/kilo-token-policy';
import { logger } from './logger';
import type { HonoContext } from '../ai-attribution.worker';
import { OrganizationJWTPayload } from '../schemas';
import {
  findAttributionIdentityRefusal,
  type AttributionIdentityClaims,
  type AttributionIdentityRefusal,
} from './attribution-identity';

// Attribution writes from a token whose account or organization access stopped are best
// retried once the dependency that decides it answers again.
const ACCOUNT_CHECK_RETRY_AFTER_SECONDS = 5;
const ACCOUNT_CHECK_STATEMENT_TIMEOUT_MS = 2_000;

export type AttributionIdentityCheck = (
  env: HonoContext['Bindings'],
  claims: AttributionIdentityClaims
) => Promise<AttributionIdentityRefusal | null>;

const checkIdentityInDatabase: AttributionIdentityCheck = async (env, claims) => {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, {
    statement_timeout: ACCOUNT_CHECK_STATEMENT_TIMEOUT_MS,
  });
  return findAttributionIdentityRefusal(db, claims);
};

/**
 * Validates a Kilo API JWT token, asserting it carries organization claims.
 */
export async function validateKiloToken(
  authHeader: string | null,
  secret: string
): Promise<
  | ({ success: true; token: string } & Pick<
      OrganizationJWTPayload,
      'organizationId' | 'organizationRole' | 'kiloUserId'
    >)
  | { success: false; error: string }
> {
  const token = extractBearerToken(authHeader);
  if (!token) {
    return { success: false, error: 'Missing or malformed Authorization header' };
  }

  try {
    const raw = await verifyKiloTokenForResource(token, secret, {
      audience: AI_ATTRIBUTION_AUDIENCE,
      mode: 'allow-legacy',
    });
    const payload = OrganizationJWTPayload.parse(raw);

    return {
      success: true,
      kiloUserId: payload.kiloUserId,
      token,
      organizationId: payload.organizationId,
      organizationRole: payload.organizationRole,
    };
  } catch {
    return { success: false, error: 'Invalid or expired token' };
  }
}

/**
 * Hono middleware for authenticating requests with Kilo API tokens. A valid token is not
 * enough: the identity it names must still act for the organization it names.
 */
export function createAuthMiddleware(
  checkIdentity: AttributionIdentityCheck = checkIdentityInDatabase
): MiddlewareHandler<HonoContext> {
  return createMiddleware<HonoContext>(async (c, next) => {
    const result = await validateKiloToken(
      c.req.header('Authorization') ?? null,
      await c.env.NEXTAUTH_SECRET.get()
    );

    if (!result.success) {
      logger.warn('Authentication failed', { error: result.error });
      return c.json({ success: false, error: result.error }, 401);
    }

    const claims: AttributionIdentityClaims = {
      kiloUserId: result.kiloUserId,
      organizationId: result.organizationId,
    };

    let refusal: AttributionIdentityRefusal | null;
    try {
      refusal = await checkIdentity(c.env, claims);
    } catch (error) {
      logger.error('Account check failed', {
        ...claims,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ success: false, error: 'Account checks are temporarily unavailable' }, 503, {
        'retry-after': String(ACCOUNT_CHECK_RETRY_AFTER_SECONDS),
      });
    }

    if (refusal !== null) {
      logger.warn('Attribution identity refused', { ...claims, reason: refusal });
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    c.set('user_id', result.kiloUserId);
    c.set('token', result.token);
    c.set('organization_id', result.organizationId);
    c.set('organization_role', result.organizationRole);

    logger.info('Request authenticated', {
      userId: result.kiloUserId,
      organizationId: result.organizationId,
      organizationRole: result.organizationRole,
    });

    return next();
  });
}

export const authMiddleware = createAuthMiddleware();
