import { describe, it, expect, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { backfillBlockedUserPepperBatch, blockedUserPepperBackfillCandidates } from './route';

beforeEach(async () => {
  await cleanupDbForTest();
});

async function candidateIds(): Promise<string[]> {
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(blockedUserPepperBackfillCandidates);
  return rows.map(r => r.id);
}

describe('blockedUserPepperBackfillCandidates', () => {
  it('matches blocked users with a null pepper only', async () => {
    const blockedNullPepper = await insertTestUser({
      blocked_reason: 'abuse',
      api_token_pepper: null,
    });
    const blockedWithPepper = await insertTestUser({
      blocked_reason: 'abuse',
      api_token_pepper: 'already-rotated',
    });
    const unblockedNullPepper = await insertTestUser({ api_token_pepper: null });
    const softDeleted = await insertTestUser({
      blocked_reason: 'soft-deleted at 2026-01-15T12:00:00.000Z',
      api_token_pepper: 'soft-delete-pepper',
    });

    const matches = await candidateIds();

    expect(matches).toContain(blockedNullPepper.id);
    expect(matches).not.toContain(blockedWithPepper.id);
    expect(matches).not.toContain(unblockedNullPepper.id);
    expect(matches).not.toContain(softDeleted.id);
  });
});

describe('backfillBlockedUserPepperBatch', () => {
  it('assigns a fresh pepper to blocked users that lack one', async () => {
    const blocked = await insertTestUser({ blocked_reason: 'abuse', api_token_pepper: null });

    const result = await backfillBlockedUserPepperBatch();

    expect(result.processed).toBe(1);
    expect(result.remaining).toBe(false);

    const [row] = await db
      .select({ api_token_pepper: kilocode_users.api_token_pepper })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, blocked.id));
    expect(row.api_token_pepper).toEqual(expect.any(String));
    expect(row.api_token_pepper).not.toBeNull();

    expect(await candidateIds()).not.toContain(blocked.id);
  });

  it('leaves unblocked users and already-rotated blocked users untouched', async () => {
    const unblocked = await insertTestUser({ api_token_pepper: null });
    const blockedWithPepper = await insertTestUser({
      blocked_reason: 'abuse',
      api_token_pepper: 'already-rotated',
    });

    const result = await backfillBlockedUserPepperBatch();

    expect(result.processed).toBe(0);

    const rows = await db
      .select({ id: kilocode_users.id, api_token_pepper: kilocode_users.api_token_pepper })
      .from(kilocode_users);
    const byId = new Map(rows.map(r => [r.id, r.api_token_pepper]));
    expect(byId.get(unblocked.id)).toBeNull();
    expect(byId.get(blockedWithPepper.id)).toBe('already-rotated');
  });

  it('rotates distinct peppers across multiple blocked users', async () => {
    const a = await insertTestUser({ blocked_reason: 'abuse', api_token_pepper: null });
    const b = await insertTestUser({ blocked_reason: 'abuse', api_token_pepper: null });

    const result = await backfillBlockedUserPepperBatch();
    expect(result.processed).toBe(2);

    const rows = await db
      .select({ id: kilocode_users.id, api_token_pepper: kilocode_users.api_token_pepper })
      .from(kilocode_users);
    const byId = new Map(rows.map(r => [r.id, r.api_token_pepper]));
    const pa = byId.get(a.id);
    const pb = byId.get(b.id);
    expect(pa).toEqual(expect.any(String));
    expect(pb).toEqual(expect.any(String));
    expect(pa).not.toBe(pb);
  });
});
