import 'server-only';
import { db } from '@/lib/drizzle';
import { device_sessions, device_refresh_tokens, kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { createHash, randomBytes } from 'node:crypto';
import { persistAttestedKeyTx, type VerifyAdmissionOk } from './native-admission';

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
 *
 * The consume and the replacement issuance run in one transaction. If issuing
 * the replacement fails, the transaction rolls back so the old token stays
 * usable instead of leaving the client with a permanently dead refresh path.
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

  // Steps 4-7: Consume the old token and issue the replacement pair in one
  // transaction. If issuing the replacement fails, the transaction rolls back
  // and the old token remains usable, so the client can retry with it.
  const outcome = await db.transaction(async tx => {
    // Fetch the full user for token generation BEFORE consuming, so a missing
    // user refuses without burning the token.
    const [fullUser] = await tx
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, session.kilo_user_id))
      .limit(1);

    if (!fullUser) {
      return { kind: 'missing_user' } as const;
    }

    // Step 4: Atomic consume — only after all precondition checks pass.
    const [consumed] = await tx
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
      return { kind: 'consume_lost' } as const;
    }

    // Step 6: Update last_seen_at on the session.
    await tx
      .update(device_sessions)
      .set({ last_seen_at: now })
      .where(eq(device_sessions.id, consumed.device_session_id));

    // Step 7: Issue the replacement pair in the same transaction.
    const accessToken = generateApiToken(
      fullUser,
      { deviceSessionId: session.id },
      { expiresIn: TOKEN_EXPIRY.oneHour }
    );

    const newRefreshToken = generateRefreshToken();
    const newExpiresAt = new Date(Date.now() + TOKEN_EXPIRY.thirtyDays * 1000).toISOString();

    await tx.insert(device_refresh_tokens).values({
      token_hash: hashToken(newRefreshToken),
      device_session_id: session.id,
      expires_at: newExpiresAt,
    });

    return {
      kind: 'ok',
      pair: { token: accessToken, refreshToken: newRefreshToken, expiresIn: TOKEN_EXPIRY.oneHour },
    } as const;
  });

  if (outcome.kind !== 'ok') {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  return { ok: true, ...outcome.pair };
}

/**
 * Create a device session and persist the attested key in a single transaction.
 *
 * Bind key persistence and session creation atomically so that a partial failure
 * never leaves one committed without the other when supportsRefresh is true.
 *
 * Returns the session ID and credential pair on success.
 * Throws KeyCollisionError if the key already belongs to a different user.
 */
export async function createDeviceSessionWithAttestedKey(params: {
  userId: string;
  userAgent?: string;
  user: User;
  verification: VerifyAdmissionOk;
}): Promise<{ token: string; refreshToken: string; expiresIn: number; sessionId: string }> {
  return await db.transaction(async tx => {
    // Persist the attested key inside the transaction
    await persistAttestedKeyTx(tx, params.userId, params.verification);

    // Create the device session
    const [session] = await tx
      .insert(device_sessions)
      .values({
        kilo_user_id: params.userId,
        user_agent: params.userAgent,
      })
      .returning({ id: device_sessions.id });

    if (!session) {
      throw new Error('Failed to create device session');
    }

    // Issue credentials
    const accessToken = generateApiToken(
      params.user,
      { deviceSessionId: session.id },
      { expiresIn: TOKEN_EXPIRY.oneHour }
    );

    const refreshToken = generateRefreshToken();
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY.thirtyDays * 1000).toISOString();

    await tx.insert(device_refresh_tokens).values({
      token_hash: tokenHash,
      device_session_id: session.id,
      expires_at: expiresAt,
    });

    return {
      token: accessToken,
      refreshToken,
      expiresIn: TOKEN_EXPIRY.oneHour,
      sessionId: session.id,
    };
  });
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
