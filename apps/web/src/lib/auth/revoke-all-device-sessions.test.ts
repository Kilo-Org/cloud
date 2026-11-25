import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, kilocode_users } from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { asc, inArray } from 'drizzle-orm';
import {
  isDeviceSessionActive,
  resetDeviceSessionCacheForTest,
} from '@kilocode/web-shared/lib/auth/device-session-cache';
import { issueSessionCredentials, rotateRefreshToken } from './device-sessions';
import {
  SECRET_ROTATION_REVOKED_REASON,
  countLiveDeviceSessions,
  countSecretRotationRevokedSessions,
  revokeAllLiveDeviceSessions,
} from './revoke-all-device-sessions';

const suffix = Date.now();
const userIds = [`test-revoke-all-a-${suffix}`, `test-revoke-all-b-${suffix}`];

const cutoff = new Date('2026-11-25T12:00:00.000Z');
const beforeCutoff = new Date(cutoff.getTime() - 60 * 60 * 1000).toISOString();
const afterCutoff = new Date(cutoff.getTime() + 1000).toISOString();
const earlierRevokedAt = '2026-11-01T00:00:00.000Z';

type Fixture = {
  liveApp: string[];
  liveDeviceAuth: string;
  alreadyRevoked: string;
  createdAfterCutoff: string;
};

async function insertSession(
  values: Partial<typeof device_sessions.$inferInsert> & {
    kilo_user_id: string;
  }
): Promise<string> {
  const [row] = await db
    .insert(device_sessions)
    .values({ created_at: beforeCutoff, last_seen_at: beforeCutoff, ...values })
    .returning({ id: device_sessions.id });
  if (!row) throw new Error('insert failed');
  return row.id;
}

async function readSessions() {
  return db
    .select({
      id: device_sessions.id,
      revoked_at: device_sessions.revoked_at,
      revoked_reason: device_sessions.revoked_reason,
    })
    .from(device_sessions)
    .where(inArray(device_sessions.kilo_user_id, userIds))
    .orderBy(asc(device_sessions.id));
}

function byId(rows: Awaited<ReturnType<typeof readSessions>>, id: string) {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`session ${id} not found`);
  return row;
}

describe('revokeAllLiveDeviceSessions', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    resetDeviceSessionCacheForTest();
    await db.insert(kilocode_users).values(
      userIds.map(id => ({
        id,
        google_user_email: `${id}@example.com`,
        google_user_name: 'Test User',
        google_user_image_url: 'https://example.com/avatar.jpg',
        stripe_customer_id: `cus_${id}`,
      }))
    );

    const [userA, userB] = userIds;
    fixture = {
      liveApp: [
        await insertSession({ kilo_user_id: userA }),
        await insertSession({ kilo_user_id: userA }),
        await insertSession({ kilo_user_id: userB }),
        await insertSession({ kilo_user_id: userB }),
      ],
      liveDeviceAuth: await insertSession({
        kilo_user_id: userA,
        device_auth_request_id: randomUUID(),
      }),
      alreadyRevoked: await insertSession({
        kilo_user_id: userB,
        revoked_at: earlierRevokedAt,
        revoked_reason: 'logout',
      }),
      createdAfterCutoff: await insertSession({
        kilo_user_id: userA,
        created_at: afterCutoff,
        last_seen_at: afterCutoff,
      }),
    };
  });

  afterEach(async () => {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  });

  test('dry-run counts split app and device-auth sessions and change nothing', async () => {
    const before = await readSessions();

    const counts = await countLiveDeviceSessions(cutoff);

    expect(counts).toEqual({ app: 4, deviceAuth: 1, total: 5 });
    expect(await readSessions()).toEqual(before);
    expect(await countSecretRotationRevokedSessions()).toBe(0);
  });

  test('revokes every live session before the cutoff in batches and leaves the rest unchanged', async () => {
    const batches: number[] = [];

    const result = await revokeAllLiveDeviceSessions({
      createdBefore: cutoff,
      batchSize: 2,
      onBatch: ({ revokedInBatch }) => batches.push(revokedInBatch),
    });

    expect(result).toEqual({ revoked: 5, batches: 3 });
    expect(batches).toEqual([2, 2, 1]);

    const rows = await readSessions();
    for (const id of [...fixture.liveApp, fixture.liveDeviceAuth]) {
      const row = byId(rows, id);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe(SECRET_ROTATION_REVOKED_REASON);
    }

    const alreadyRevoked = byId(rows, fixture.alreadyRevoked);
    expect(alreadyRevoked.revoked_reason).toBe('logout');
    expect(new Date(alreadyRevoked.revoked_at ?? '').toISOString()).toBe(earlierRevokedAt);

    const afterCutoffRow = byId(rows, fixture.createdAfterCutoff);
    expect(afterCutoffRow.revoked_at).toBeNull();
    expect(afterCutoffRow.revoked_reason).toBeNull();

    expect(await countLiveDeviceSessions(cutoff)).toEqual({ app: 0, deviceAuth: 0, total: 0 });
    expect(await countSecretRotationRevokedSessions()).toBe(5);
  });

  test('a rerun is a no-op', async () => {
    await revokeAllLiveDeviceSessions({ createdBefore: cutoff });
    const afterFirstRun = await readSessions();

    const rerun = await revokeAllLiveDeviceSessions({ createdBefore: cutoff });

    expect(rerun).toEqual({ revoked: 0, batches: 0 });
    expect(await readSessions()).toEqual(afterFirstRun);
  });

  test('refresh after the revocation returns SESSION_REVOKED', async () => {
    const [sessionId] = fixture.liveApp;
    const user = await db.query.kilocode_users.findFirst({
      where: (users, { eq }) => eq(users.id, userIds[0]),
    });
    const { refreshToken } = await issueSessionCredentials(user as User, sessionId);

    await revokeAllLiveDeviceSessions({ createdBefore: cutoff });

    const result = await rotateRefreshToken(refreshToken);
    expect(result).toEqual({ ok: false, error: 'SESSION_REVOKED' });
  });

  test('drops the cached active answer in the revoking process', async () => {
    const [sessionId] = fixture.liveApp;
    const [userId] = userIds;
    expect(await isDeviceSessionActive(sessionId, userId, async () => true)).toBe(true);

    await revokeAllLiveDeviceSessions({ createdBefore: cutoff });

    expect(await isDeviceSessionActive(sessionId, userId, async () => false)).toBe(false);
  });

  test('rejects a non-positive batch size', async () => {
    await expect(
      revokeAllLiveDeviceSessions({ createdBefore: cutoff, batchSize: 0 })
    ).rejects.toThrow('batchSize must be a positive integer');
  });
});
