import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { extractBearerToken, verifyCallbackToken, verifyKiloToken } from '@kilocode/worker-utils';
import { queuedIdentityKey, type QueuedIsolateIdentity } from './types';
import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import type { Env, SecretBinding } from './types';

type VerifyBearer = (params: {
  token: string | null;
  nextAuthSecret: string;
  workerEnv: string;
  requirePepper: true;
  requiredTokenSource?: string;
  maxTokenLifetimeSeconds?: number;
  connectionString: string;
}) => Promise<{ userId: string } | null>;

function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = Buffer.from(a);
  const bytesB = Buffer.from(b);
  if (bytesA.length !== bytesB.length) {
    nodeTimingSafeEqual(bytesA, bytesA);
    return false;
  }
  return nodeTimingSafeEqual(bytesA, bytesB);
}

type AuthFailure = {
  success: false;
  status: 401 | 500 | 503;
  error: string;
};

export type IsolateReviewAuthResult =
  | {
      success: true;
      userId: string;
      token: string;
      credentialsExpireAt: number;
      organizationId?: string;
    }
  | AuthFailure;

export type IsolateReviewHonoEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    kiloToken: string;
    credentialsExpireAt: number;
  };
};

export async function resolveSecret(
  secret: SecretBinding | null | undefined
): Promise<string | null> {
  if (!secret) return null;
  if (typeof secret === 'string') return secret;

  try {
    return await secret.get();
  } catch {
    return null;
  }
}

export async function authenticateIsolateReviewRequest(options: {
  internalApiKey: string | null | undefined;
  expectedInternalApiKey: SecretBinding | null | undefined;
  authorization: string | null | undefined;
  nextAuthSecret: SecretBinding | null | undefined;
  workerEnv: string | null | undefined;
  connectionString: string | null | undefined;
  verifyBearer?: VerifyBearer;
  requirePurpose?: boolean;
}): Promise<IsolateReviewAuthResult> {
  const expectedInternalApiKey = await resolveSecret(options.expectedInternalApiKey);
  if (!expectedInternalApiKey) {
    return {
      success: false,
      status: 500,
      error: 'Internal API secret is not configured on the worker',
    };
  }

  if (!options.internalApiKey || !timingSafeEqual(options.internalApiKey, expectedInternalApiKey)) {
    return {
      success: false,
      status: 401,
      error: 'Invalid or missing internal API key',
    };
  }

  const token = extractBearerToken(options.authorization);
  if (!token) {
    return {
      success: false,
      status: 401,
      error: 'Missing or malformed Authorization header',
    };
  }

  const nextAuthSecret = await resolveSecret(options.nextAuthSecret);
  if (!nextAuthSecret || !options.workerEnv || !options.connectionString) {
    return {
      success: false,
      status: 500,
      error: 'Kilo token verification is not configured on the worker',
    };
  }

  try {
    const verifyBearer =
      options.verifyBearer ??
      (await import('@kilocode/worker-utils/kilo-token-auth')).verifyKiloBearerAgainstCurrentPepper;
    const auth = await verifyBearer({
      token,
      nextAuthSecret,
      workerEnv: options.workerEnv,
      requirePepper: true,
      ...(options.requirePurpose || options.workerEnv === 'production'
        ? { requiredTokenSource: 'isolate-review', maxTokenLifetimeSeconds: 60 * 60 }
        : {}),
      connectionString: options.connectionString,
    });
    if (!auth) {
      return {
        success: false,
        status: 401,
        error: 'Invalid or expired Kilo token',
      };
    }

    const claims = await verifyKiloToken(token, nextAuthSecret).catch(() => null);
    if (
      !claims ||
      claims.kiloUserId !== auth.userId ||
      claims.exp === undefined ||
      !Number.isSafeInteger(claims.exp * 1000) ||
      claims.exp * 1000 <= Date.now() ||
      (options.requirePurpose &&
        (claims.tokenSource !== 'isolate-review' ||
          !Number.isSafeInteger(claims.iat) ||
          claims.iat === undefined ||
          claims.exp - claims.iat > 3_600 ||
          claims.exp <= claims.iat ||
          claims.iat * 1000 > Date.now() ||
          claims.env !== options.workerEnv ||
          !claims.apiTokenPepper))
    ) {
      return { success: false, status: 401, error: 'Invalid or expired Kilo token' };
    }
    return {
      success: true,
      userId: auth.userId,
      token,
      credentialsExpireAt: claims.exp * 1000,
      ...(claims.organizationId ? { organizationId: claims.organizationId } : {}),
    };
  } catch {
    return {
      success: false,
      status: 503,
      error: 'Kilo token verification is temporarily unavailable',
    };
  }
}

export async function authenticateQueuedControl(options: {
  env: Env;
  internalApiKey: string | undefined;
  token: string | undefined;
  identity: QueuedIsolateIdentity;
  operation: 'status' | 'cancel';
}): Promise<boolean> {
  const secret = await resolveSecret(options.env.INTERNAL_API_SECRET);
  if (!secret || !options.internalApiKey || !timingSafeEqual(options.internalApiKey, secret))
    return false;
  return verifyCallbackToken({
    secret,
    token: options.token,
    scope: 'queued-isolate-control',
    resourceParts: [options.operation, queuedIdentityKey(options.identity)],
  });
}

export const isolateReviewAuthMiddleware = createMiddleware<IsolateReviewHonoEnv>(
  async (c: Context<IsolateReviewHonoEnv>, next: Next) => {
    const result = await authenticateIsolateReviewRequest({
      internalApiKey: c.req.header('x-internal-api-key'),
      expectedInternalApiKey: c.env.INTERNAL_API_SECRET,
      authorization: c.req.header('authorization'),
      nextAuthSecret: c.env.NEXTAUTH_SECRET,
      workerEnv: c.env.ENVIRONMENT,
      connectionString: c.env.HYPERDRIVE?.connectionString,
    });

    if (!result.success) return c.json({ error: result.error }, result.status);

    c.set('userId', result.userId);
    c.set('kiloToken', result.token);
    c.set('credentialsExpireAt', result.credentialsExpireAt);
    return next();
  }
);
