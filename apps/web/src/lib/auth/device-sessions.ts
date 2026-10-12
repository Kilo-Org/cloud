import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, device_refresh_tokens, kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { eq, and, isNull, gt, sql, getTableColumns } from 'drizzle-orm';
import { generateApiToken, TOKEN_EXPIRY } from '@kilocode/web-shared/lib/tokens';
import { createHash, randomBytes } from 'node:crypto';
import { persistAttestedKeyTx, type VerifyAdmissionOk } from './native-admission';

const REFRESH_TOKEN_BYTES = 32;

/**
 * How long a consumed refresh token can rotate again while the pair it was
 * exchanged for was never used. A mobile client loses a rotation response
 * when the OS suspends the app mid-request, the connection drops, or the
 * keychain write fails. The client then retries with the token it still holds.
 * Without this window, that retry is reuse and revokes the session.
 */
const LOST_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

function isWithinLostRotationGrace(consumedAt: string): boolean {
  return Date.now() - new Date(consumedAt).getTime() < LOST_ROTATION_GRACE_MS;
}

async function revokeForReuse(deviceSessionId: string, revokedAt: string): Promise<void> {
  await db
    .update(device_sessions)
    .set({ revoked_at: revokedAt, revoked_reason: 'refresh_reuse_detected' })
    .where(eq(device_sessions.id, deviceSessionId));
  console.warn('[native-refresh] refresh token reuse detected; session revoked', {
    deviceSessionId,
  });
}

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
 * An unknown or expired token is refused without revocation.
 *
 * Reuse detection: a consumed token is a replay, and the session is revoked,
 * when the session chain has advanced past it (a later token was consumed) or
 * it was consumed more than `LOST_ROTATION_GRACE_MS` ago. Otherwise the pair
 * it was exchanged for was never used: the client lost the response. The
 * token then rotates again and the unused pair is retired. A retired token is
 * stamped with the original consume time, so a later use of it is a replay
 * and revokes the session. The session keeps one live refresh token.
 *
 * Stale requests: a request that read the token before the consume that won
 * is refused without revocation and retires nothing. After a client timeout,
 * the aborted request can reach the session lock after the retry. It must not
 * retire the pair that the retry delivered.
 *
 * Each consume is stamped with the database time of the request's first read
 * (`firstReadAt`), not with the time it got the lock. A request writes only if
 * its first read came after the consume it replaces, so the consume times of
 * a session are ordered, and a stale request is identified in either lock
 * order.
 *
 * The session validity check is repeated INSIDE the transaction under a row
 * lock, so a session revoked concurrently with the rotation cannot receive a
 * replacement pair. The same lock serializes every rotation of the session.
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
  // `firstReadAt` is the database time of this request's first read.
  const [row] = await db
    .select({
      ...getTableColumns(device_refresh_tokens),
      firstReadAt: sql<string>`clock_timestamp()::text`,
    })
    .from(device_refresh_tokens)
    .where(eq(device_refresh_tokens.token_hash, tokenHash))
    .limit(1);

  // Unknown token: refuse without revocation.
  if (!row) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }
  const { firstReadAt } = row;

  // Expired token: refuse without revocation.
  if (new Date(row.expires_at) <= new Date()) {
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  // Consumed outside the lost-rotation grace: refuse AND revoke the session.
  // A consume inside the grace is decided under the session lock below.
  if (row.consumed_at && !isWithinLostRotationGrace(row.consumed_at)) {
    await revokeForReuse(row.device_session_id, now);
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

    // Step 4: Lock the parent session row and recheck revoked_at INSIDE the
    // transaction, before consuming. The pre-transaction session check above
    // can be raced by a revokeDeviceSession that commits between that read and
    // this point; holding the session row lock until this transaction commits
    // closes the gap — the revoke either commits first and this recheck refuses,
    // or it blocks until this rotation commits.
    const [lockedSession] = await tx
      .select()
      .from(device_sessions)
      .where(eq(device_sessions.id, session.id))
      .for('update')
      .limit(1);

    if (!lockedSession) {
      return { kind: 'missing_session' } as const;
    }

    if (lockedSession.revoked_at) {
      return { kind: 'session_revoked' } as const;
    }

    // Step 5: Re-read the token under the session lock. Every rotation of
    // this session holds the same lock, so this read sees the result of any
    // rotation that ran concurrently with the checks above.
    const [current] = await tx
      .select({
        expires_at: device_refresh_tokens.expires_at,
        consumed_at: device_refresh_tokens.consumed_at,
        consumedAfterFirstRead: sql<boolean>`${device_refresh_tokens.consumed_at} >= ${firstReadAt}::timestamptz`,
      })
      .from(device_refresh_tokens)
      .where(eq(device_refresh_tokens.token_hash, tokenHash))
      .limit(1);

    if (!current || new Date(current.expires_at) <= new Date()) {
      return { kind: 'invalid_token' } as const;
    }

    if (current.consumed_at) {
      // The consume that won happened after this request read the token:
      // this request is stale. Refuse it and change nothing.
      if (current.consumedAfterFirstRead) {
        return { kind: 'stale_request' } as const;
      }

      const consumedAt = current.consumed_at;
      const [laterConsume] = await tx
        .select({ token_hash: device_refresh_tokens.token_hash })
        .from(device_refresh_tokens)
        .where(
          and(
            eq(device_refresh_tokens.device_session_id, lockedSession.id),
            gt(device_refresh_tokens.consumed_at, consumedAt)
          )
        )
        .limit(1);

      if (laterConsume || !isWithinLostRotationGrace(consumedAt)) {
        return { kind: 'reuse_detected' } as const;
      }

      // Lost rotation: retire the unused replacement with this token's
      // consume time, then stamp this token again.
      await tx
        .update(device_refresh_tokens)
        .set({ consumed_at: consumedAt })
        .where(
          and(
            eq(device_refresh_tokens.device_session_id, lockedSession.id),
            isNull(device_refresh_tokens.consumed_at)
          )
        );
      await tx
        .update(device_refresh_tokens)
        .set({ consumed_at: firstReadAt })
        .where(eq(device_refresh_tokens.token_hash, tokenHash));
      console.info('[native-refresh] lost rotation recovered', {
        deviceSessionId: lockedSession.id,
      });
    } else {
      // Atomic consume — only after the in-transaction revocation check.
      const [consumed] = await tx
        .update(device_refresh_tokens)
        .set({ consumed_at: firstReadAt })
        .where(
          and(
            eq(device_refresh_tokens.token_hash, tokenHash),
            isNull(device_refresh_tokens.consumed_at),
            gt(device_refresh_tokens.expires_at, now)
          )
        )
        .returning({ token_hash: device_refresh_tokens.token_hash });

      if (!consumed) {
        return { kind: 'invalid_token' } as const;
      }
    }

    // Step 6: Update last_seen_at on the session.
    await tx
      .update(device_sessions)
      .set({ last_seen_at: now })
      .where(eq(device_sessions.id, lockedSession.id));

    // Step 7: Issue the replacement pair in the same transaction.
    const accessToken = generateApiToken(
      fullUser,
      { deviceSessionId: lockedSession.id },
      { expiresIn: TOKEN_EXPIRY.oneHour }
    );

    const newRefreshToken = generateRefreshToken();
    const newExpiresAt = new Date(Date.now() + TOKEN_EXPIRY.thirtyDays * 1000).toISOString();

    await tx.insert(device_refresh_tokens).values({
      token_hash: hashToken(newRefreshToken),
      device_session_id: lockedSession.id,
      expires_at: newExpiresAt,
    });

    return {
      kind: 'ok',
      pair: { token: accessToken, refreshToken: newRefreshToken, expiresIn: TOKEN_EXPIRY.oneHour },
    } as const;
  });

  if (outcome.kind === 'session_revoked') {
    return { ok: false, error: 'SESSION_REVOKED' };
  }

  if (outcome.kind === 'reuse_detected') {
    await revokeForReuse(session.id, now);
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

  if (outcome.kind === 'stale_request') {
    console.info('[native-refresh] stale rotation request refused', {
      deviceSessionId: session.id,
    });
    return { ok: false, error: 'INVALID_REFRESH_TOKEN' };
  }

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
