import { describe, it, expect, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { backfillBlockedAtBatch, blockedAtBackfillCandidates } from './route';

beforeEach(async () => {
  await cleanupDbForTest();
});

async function missingBlockedAtUserIds(): Promise<string[]> {
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(blockedAtBackfillCandidates);
  return rows.map(r => r.id);
}

describe('blockedAtBackfillCandidates', () => {
  it('matches blocked users missing blocked_at', async () => {
    const blocked = await insertTestUser({ blocked_reason: 'abuse' });
    const unblocked = await insertTestUser();
    const alreadyBackfilled = await insertTestUser({
      blocked_reason: 'abuse',
      blocked_at: '2026-01-15T12:00:00.000Z',
    });
    const softDeleted = await insertTestUser({
      blocked_reason: 'soft-deleted at 2026-01-15T12:00:00.000Z',
    });

    const matches = await missingBlockedAtUserIds();

    expect(matches).toContain(blocked.id);
    expect(matches).not.toContain(unblocked.id);
    expect(matches).not.toContain(alreadyBackfilled.id);
    expect(matches).not.toContain(softDeleted.id);
  });
});

describe('backfillBlockedAtBatch', () => {
  it('copies updated_at into blocked_at and leaves blocked_by unknown', async () => {
    const updatedAt = '2026-01-15T12:00:00.000Z';
    const user = await insertTestUser({ blocked_reason: 'abuse', updated_at: updatedAt });

    const result = await backfillBlockedAtBatch();

    expect(result.processed).toBe(1);
    expect(result.remaining).toBe(false);

    const [row] = await db
      .select({
        blocked_at: kilocode_users.blocked_at,
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
        updated_at: kilocode_users.updated_at,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));

    expect(new Date(row.blocked_at ?? '').toISOString()).toBe(updatedAt);
    expect(new Date(row.updated_at).toISOString()).toBe(updatedAt);
    expect(row.blocked_by_kilo_user_id).toBeNull();

    const matches = await missingBlockedAtUserIds();
    expect(matches).not.toContain(user.id);
  });
});
