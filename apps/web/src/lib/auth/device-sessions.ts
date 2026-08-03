import 'server-only';
import { db } from '@/lib/drizzle';
import { device_sessions, device_refresh_tokens, kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { createHash, randomBytes } from 'node:crypto';

const REFRESH_TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * Create a new device session.
 * @returns the created session ID.
 */
export async function createDeviceSession(params: {
  userId: string;
  userAgent?: string;
  deviceAuthRequestId?: string;
}): Promise<string> {
  const [session] = await db
    .insert(device_sessions)
    .values({
      kilo_user_id: params.userId,
      user_agent: params.userAgent,
      device_auth_request_id: params.deviceAuthRequestId,
    })
    .returning({ id: device_sessions.id });

  if (!session) {
    throw new Error('Failed to create device session');
  }

  return session.id;
}

/**
 * Issue an access token + refresh token pair for a device session.
 * The access token is short-lived (one hour). The refresh token is 30 days.
 */
export async function issueSessionCredentials(
  user: User,
  deviceSessionId: string
): Promise<{ token: string; refreshToken: string; expiresIn: number }> {
  const accessToken = generateApiToken(
    user,
    { deviceSessionId },
    { expiresIn: TOKEN_EXPIRY.oneHour }
  );

  const refreshToken = generateRefreshToken();
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY.thirtyDays * 1000).toISOString();

  await db.insert(device_refresh_tokens).values({
    token_hash: tokenHash,
    device_session_id: deviceSessionId,
    expires_at: expiresAt,
  });

  return {
    token: accessToken,
    refreshToken,
    expiresIn: TOKEN_EXPIRY.oneHour,
  };
}

/**
 * Rotate a refresh token. On success, returns a new token pair.
 * On failure, returns null with an error code.
 *
 * Precondition checks (session validity, user blocked_reason) happen BEFORE
 * the atomic consume, so a blocked refusal does not consume the token.
 * Reuse-detection: if the refresh token was already consumed (consumed_at is set),
 * the session is revoked because replay implies theft.
 * An unknown or expired token is refused without revocation.
 */
export async function rotateRefreshToken(
  refreshToken: string
): Promise<
  | { ok: true; token: string; refreshToken: string; expiresIn: number }
  | { ok: false; error: 'INVALID_REFRESH_TOKEN' | 'SESSION_REVOKED' | 'USER_BLOCKED' }
> {
  const tokenHash = hashToken(refreshToken);
  const now = new Date().toISOString();

  // Step 1: Look up the token row to check validity and reuse BEFORE consuming.
  const [row] = await db
    .select()
    .from(device_refresh_tokens)
    .where(eq(device_refresh_tokens.token_hash, tokenHash))
    .limit(1);

  // Unknown token: refuse without revocation.
  if (!row) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  // Expired token: refuse without revocation.
  if (new Date(row.expires_at) <= new Date()) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  // Reused (consumed_at is set): refuse AND revoke the session.
  if (row.consumed_at) {
    await db
      .update(device_sessions)
      .set({
        revoked_at: now,
        revoked_reason: 'refresh_reuse_detected',
      })
      .where(eq(device_sessions.id, row.device_session_id));
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  // Step 2: Check parent session validity BEFORE consuming.
  const [session] = await db
    .select()
    .from(device_sessions)
    .where(eq(device_sessions.id, row.device_session_id))
    .limit(1);

  if (!session) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  if (session.revoked_at) {
    return { ok: false, error: 'SESSION_REVOKED' };
  }

  // Step 3: Check user blocked_reason BEFORE consuming.
  const [user] = await db
    .select({ id: kilocode_users.id, blocked_reason: kilocode_users.blocked_reason })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, session.kilo_user_id))
    .limit(1);

  if (!user) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  if (user.blocked_reason) {
    return { ok: false, error: 'USER_BLOCKED' };
  }

  // Step 4: Atomic consume — only after all precondition checks pass.
  const [consumed] = await db
    .update(device_refresh_tokens)
    .set({ consumed_at: now })
    .where(
      and(
        eq(device_refresh_tokens.token_hash, tokenHash),
        isNull(device_refresh_tokens.consumed_at),
        gt(device_refresh_tokens.expires_at, now)
      )
    )
    .returning();

  // Step 5: If consume failed, a concurrent request consumed the token.
  // We already confirmed the token was not reused at Step 1, so this is
  // a race, not theft. Refuse without revocation.
  if (!consumed) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  // Step 6: Update last_seen_at on the session.
  await db
    .update(device_sessions)
    .set({ last_seen_at: now })
    .where(eq(device_sessions.id, consumed.device_session_id));

  // Fetch full user for token generation.
  const [fullUser] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, session.kilo_user_id))
    .limit(1);

  if (!fullUser) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  // Step 7: Issue new pair.
  const newPair = await issueSessionCredentials(fullUser, session.id);

  return { ok: true, ...newPair };
}

/**
 * Revoke a device session and all its refresh tokens.
 */
export async function revokeDeviceSession(sessionId: string, reason: string): Promise<void> {
  await db
    .update(device_sessions)
    .set({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    })
    .where(eq(device_sessions.id, sessionId));
}
