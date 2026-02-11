import { jwtVerify } from 'jose';
import { KILO_TOKEN_VERSION } from '../config';

/**
 * Shape of the JWT payload issued by the cloud Next.js app.
 * Must stay in sync with cloud's generateApiToken() in src/lib/tokens.ts.
 */
export type TokenPayload = {
  kiloUserId: string;
  apiTokenPepper: string | null;
  version: number;
  env?: string;
};

export type ValidateResult =
  | { success: true; userId: string; token: string; pepper: string | null }
  | { success: false; error: string };

function parseTokenPayload(
  raw: Record<string, unknown>
): { ok: true; payload: TokenPayload } | { ok: false; error: string } {
  const { kiloUserId, apiTokenPepper, version } = raw;
  if (typeof kiloUserId !== 'string') {
    return { ok: false, error: 'Missing or invalid kiloUserId' };
  }
  if (
    apiTokenPepper !== null &&
    apiTokenPepper !== undefined &&
    typeof apiTokenPepper !== 'string'
  ) {
    return { ok: false, error: 'Invalid apiTokenPepper type' };
  }
  if (typeof version !== 'number') {
    return { ok: false, error: 'Missing or invalid version' };
  }
  const env = typeof raw.env === 'string' ? raw.env : undefined;
  const pepper = typeof apiTokenPepper === 'string' ? apiTokenPepper : null;
  return { ok: true, payload: { kiloUserId, apiTokenPepper: pepper, version, env } };
}

/**
 * Verify a Kilo JWT using HS256 symmetric secret.
 *
 * Checks: signature, expiration (built into jose), version === KILO_TOKEN_VERSION,
 * and optional env match against the worker's WORKER_ENV.
 */
export async function validateKiloToken(
  token: string,
  secret: string,
  expectedEnv: string | undefined
): Promise<ValidateResult> {
  let payload: TokenPayload;
  try {
    const result = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    const parsed = parseTokenPayload(result.payload);
    if (!parsed.ok) {
      return { success: false, error: parsed.error };
    }
    payload = parsed.payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JWT verification failed';
    return { success: false, error: message };
  }

  if (payload.version !== KILO_TOKEN_VERSION) {
    return { success: false, error: `Invalid token version: ${payload.version}` };
  }

  if (expectedEnv && payload.env && payload.env !== expectedEnv) {
    return { success: false, error: `Token env mismatch: ${payload.env} !== ${expectedEnv}` };
  }

  return {
    success: true,
    userId: payload.kiloUserId,
    token,
    pepper: payload.apiTokenPepper,
  };
}
