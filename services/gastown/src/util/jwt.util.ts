import jwt from 'jsonwebtoken';
import { z } from 'zod';

// ── Legacy per-agent JWT (deprecated — retained for rollout compat) ─────

export const AgentJWTPayload = z.object({
  agentId: z.string(),
  rigId: z.string(),
  townId: z.string(),
  userId: z.string(),
});

export type AgentJWTPayload = z.infer<typeof AgentJWTPayload>;

export function verifyAgentJWT(
  token: string,
  secret: string
): { success: true; payload: AgentJWTPayload } | { success: false; error: string } {
  try {
    const raw = jwt.verify(token, secret, { algorithms: ['HS256'], maxAge: '8h' });
    const parsed = AgentJWTPayload.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: 'Invalid token payload' };
    }
    return { success: true, payload: parsed.data };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Token expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid token signature' };
    }
    return { success: false, error: 'Token validation failed' };
  }
}

export function signAgentJWT(
  payload: AgentJWTPayload,
  secret: string,
  expiresInSeconds: number = 3600
): string {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
  });
}

// ── Per-container JWT (preferred — no expiry, one per container) ─────────

export const ContainerJWTPayload = z.object({
  townId: z.string(),
  userId: z.string(),
  scope: z.literal('container'),
});

export type ContainerJWTPayload = z.infer<typeof ContainerJWTPayload>;

const CONTAINER_JWT_EXPIRY_SECONDS = 8 * 3600; // 8h — same as legacy agent JWTs

/**
 * Sign a container-scoped JWT. 8h expiry, periodically refreshed by
 * the TownDO alarm. Short-lived to limit damage from exfiltration,
 * but refreshed proactively so running containers never hit expiry.
 */
export function signContainerJWT(
  payload: { townId: string; userId: string },
  secret: string
): string {
  return jwt.sign({ ...payload, scope: 'container' }, secret, {
    algorithm: 'HS256',
    expiresIn: CONTAINER_JWT_EXPIRY_SECONDS,
  });
}

/**
 * Verify a container-scoped JWT. Uses the standard 8h maxAge.
 */
export function verifyContainerJWT(
  token: string,
  secret: string
): { success: true; payload: ContainerJWTPayload } | { success: false; error: string } {
  try {
    const raw = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      maxAge: '8h',
    });
    const parsed = ContainerJWTPayload.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: 'Invalid container token payload' };
    }
    return { success: true, payload: parsed.data };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Token expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid token signature' };
    }
    return { success: false, error: 'Token validation failed' };
  }
}

// Maximum tolerated "past-expiry" window for a container JWT presented
// to the refresh endpoint. Past this, the token must be re-minted by the
// TownDO (via ensureContainerToken), not bootstrapped by the container
// itself. Keeps the renewable window bounded instead of "forever as long
// as the signature is valid".
const CONTAINER_REFRESH_GRACE_SECONDS = 24 * 3600;

/**
 * Verify a container-scoped JWT, tolerating tokens that have just expired.
 *
 * Used exclusively by endpoints whose purpose is to mint a replacement
 * token for a container whose current one has expired. The signature
 * still has to be valid, so this only accepts tokens we previously
 * issued — an attacker cannot forge a fresh payload.
 *
 * Accepts tokens up to `CONTAINER_REFRESH_GRACE_SECONDS` past their
 * `exp` claim. Beyond that, the token is considered truly dead and the
 * refresh request is rejected — this bounds the window during which a
 * stolen long-expired token could be turned into a fresh one.
 */
export function verifyContainerJWTAllowExpired(
  token: string,
  secret: string
):
  | { success: true; payload: ContainerJWTPayload; expired: boolean }
  | {
      success: false;
      error: string;
    } {
  try {
    const raw = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    });
    const parsed = ContainerJWTPayload.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: 'Invalid container token payload' };
    }
    const decoded = jwt.decode(token);
    const exp =
      decoded && typeof decoded === 'object' && 'exp' in decoded && typeof decoded.exp === 'number'
        ? decoded.exp
        : null;
    if (exp === null) {
      return { success: false, error: 'Token missing exp claim' };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsPastExpiry = nowSeconds - exp;
    if (secondsPastExpiry > CONTAINER_REFRESH_GRACE_SECONDS) {
      return { success: false, error: 'Token expired beyond refresh grace period' };
    }
    return { success: true, payload: parsed.data, expired: secondsPastExpiry > 0 };
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid token signature' };
    }
    return { success: false, error: 'Token validation failed' };
  }
}
