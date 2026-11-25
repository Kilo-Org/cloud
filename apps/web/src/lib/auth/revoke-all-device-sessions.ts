import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions } from '@kilocode/db/schema';
import { and, count, eq, inArray, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import { invalidateDeviceSession } from '@kilocode/web-shared/lib/auth/device-session-cache';

/**
 * `revoked_reason` for sessions ended by a NEXTAUTH_SECRET rotation. The
 * column is free text with no constraint; this value only has to be distinct
 * from the reasons the request paths write.
 */
export const SECRET_ROTATION_REVOKED_REASON = 'secret_rotation';

export const DEFAULT_REVOKE_BATCH_SIZE = 1000;

export type LiveDeviceSessionCounts = {
  /** Sessions minted by the mobile app sign-in surfaces. */
  app: number;
  /** Sessions minted by the CLI device-authorization flow. */
  deviceAuth: number;
  total: number;
};

/**
 * Sessions that a bulk revocation selects: not yet revoked and created before
 * the cutoff. The cutoff keeps sessions signed in after the rotation alive and
 * bounds the work, so a run terminates while sign-ins continue.
 */
function liveBefore(createdBefore: Date) {
  return and(
    isNull(device_sessions.revoked_at),
    lt(device_sessions.created_at, createdBefore.toISOString())
  );
}

export async function countLiveDeviceSessions(
  createdBefore: Date
): Promise<LiveDeviceSessionCounts> {
  const [row] = await db
    .select({
      total: count(),
      deviceAuth: count(device_sessions.device_auth_request_id),
    })
    .from(device_sessions)
    .where(liveBefore(createdBefore));

  const total = row?.total ?? 0;
  const deviceAuth = row?.deviceAuth ?? 0;
  return { app: total - deviceAuth, deviceAuth, total };
}

/**
 * Revoke every live device session created before `createdBefore`, in batches
 * of `batchSize` rows, each batch its own statement so no long transaction
 * holds session row locks.
 *
 * Idempotent: only rows with `revoked_at IS NULL` are touched, so a rerun
 * revokes nothing that an earlier run revoked, and an already-revoked
 * session keeps its original `revoked_at` and `revoked_reason`. Refresh
 * tokens are not deleted: `rotateRefreshToken` refuses every token of a
 * revoked session with `SESSION_REVOKED`.
 *
 * A concurrent rotation holds the session row lock until it commits; the
 * batch waits for it and then revokes the session, so the pair that rotation
 * issued is refused at its next refresh.
 *
 * The cached active answer is dropped for each revoked session in this
 * process only. Other processes (web and AI gateway instances) see the
 * revocation within `DEVICE_SESSION_CACHE_TTL_MS`.
 */
export async function revokeAllLiveDeviceSessions(params: {
  createdBefore: Date;
  batchSize?: number;
  onBatch?: (progress: { batch: number; revokedInBatch: number; revokedTotal: number }) => void;
}): Promise<{ revoked: number; batches: number }> {
  const batchSize = params.batchSize ?? DEFAULT_REVOKE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }

  let revoked = 0;
  let batches = 0;

  for (;;) {
    const rows = await db
      .update(device_sessions)
      .set({ revoked_at: sql`now()`, revoked_reason: SECRET_ROTATION_REVOKED_REASON })
      .where(
        and(
          isNull(device_sessions.revoked_at),
          inArray(
            device_sessions.id,
            db
              .select({ id: device_sessions.id })
              .from(device_sessions)
              .where(liveBefore(params.createdBefore))
              .orderBy(device_sessions.id)
              .limit(batchSize)
          )
        )
      )
      .returning({ id: device_sessions.id });

    if (rows.length === 0) break;

    for (const row of rows) {
      invalidateDeviceSession(row.id);
    }

    batches += 1;
    revoked += rows.length;
    params.onBatch?.({ batch: batches, revokedInBatch: rows.length, revokedTotal: revoked });
  }

  return { revoked, batches };
}

/** Sessions this reason has revoked so far, for the operator's confirmation. */
export async function countSecretRotationRevokedSessions(): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(device_sessions)
    .where(
      and(
        isNotNull(device_sessions.revoked_at),
        eq(device_sessions.revoked_reason, SECRET_ROTATION_REVOKED_REASON)
      )
    );
  return row?.total ?? 0;
}
