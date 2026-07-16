import { afterEach, describe, expect, test } from '@jest/globals';
import {
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_daily_repairs,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';

import {
  claimPendingDailyUsageRollupRepairs,
  enqueueDailyUsageRollupRepair,
  failDailyUsageRollupRepair,
  processPendingDailyUsageRollupRepairs,
  repairClaimedDailyUsageRollup,
} from './usage-daily-rollup-repairs';

const userIds: string[] = [];
const organizationIds: string[] = [];

async function createUser() {
  const user = await insertTestUser();
  userIds.push(user.id);
  return user;
}

async function createOrganization(ownerId: string) {
  const organization = await createTestOrganization(
    'Daily rollup repair test organization',
    ownerId,
    0
  );
  organizationIds.push(organization.id);
  return organization;
}

async function insertRawUsage(
  kiloUserId: string,
  cost: number,
  createdAt: string,
  organizationId: string | null = null
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(microdollar_usage).values({
    id,
    kilo_user_id: kiloUserId,
    organization_id: organizationId,
    cost,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: createdAt,
  });
  return id;
}

async function enqueueUsage(
  usageId: string,
  kiloUserId: string,
  createdAt: string,
  organizationId: string | null = null
): Promise<void> {
  await enqueueDailyUsageRollupRepair(db, {
    usageId,
    kiloUserId,
    organizationId,
    createdAt,
  });
}

async function dailyRows(kiloUserId: string, organizationId: string | null) {
  return db
    .select({
      usageDate: microdollar_usage_daily.usage_date,
      total: microdollar_usage_daily.total_cost_microdollars,
    })
    .from(microdollar_usage_daily)
    .where(
      and(
        eq(microdollar_usage_daily.kilo_user_id, kiloUserId),
        organizationId === null
          ? isNull(microdollar_usage_daily.organization_id)
          : eq(microdollar_usage_daily.organization_id, organizationId)
      )
    );
}

afterEach(async () => {
  if (userIds.length > 0) {
    await db
      .delete(microdollar_usage_daily_repairs)
      .where(inArray(microdollar_usage_daily_repairs.kilo_user_id, userIds));
    await db
      .delete(microdollar_usage_daily)
      .where(inArray(microdollar_usage_daily.kilo_user_id, userIds));
    await db.delete(microdollar_usage).where(inArray(microdollar_usage.kilo_user_id, userIds));
  }
  if (organizationIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  }
  if (userIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  }
  userIds.length = 0;
  organizationIds.length = 0;
});

describe('usage daily rollup repairs', () => {
  test('repairs a personal rollup from the canonical raw usage aggregate', async () => {
    const user = await createUser();
    const createdAt = '2026-07-14T12:00:00.000Z';
    const firstUsageId = await insertRawUsage(user.id, 125, createdAt);
    await insertRawUsage(user.id, -25, createdAt);
    await db.insert(microdollar_usage_daily).values({
      kilo_user_id: user.id,
      organization_id: null,
      usage_date: '2026-07-14',
      total_cost_microdollars: 999,
    });

    await enqueueUsage(firstUsageId, user.id, createdAt);
    expect(await processPendingDailyUsageRollupRepairs(db, { limit: 1 })).toEqual({
      claimed: 1,
      repaired: 1,
      failed: [],
    });

    expect(await dailyRows(user.id, null)).toEqual([{ usageDate: '2026-07-14', total: 100 }]);
  });

  test('keeps organization usage distinct from personal usage for the same user and day', async () => {
    const user = await createUser();
    const organization = await createOrganization(user.id);
    const createdAt = '2026-07-14T12:00:00.000Z';
    const personalUsageId = await insertRawUsage(user.id, 11, createdAt);
    const organizationUsageId = await insertRawUsage(user.id, 31, createdAt, organization.id);

    await enqueueUsage(personalUsageId, user.id, createdAt);
    await enqueueUsage(organizationUsageId, user.id, createdAt, organization.id);
    expect(await processPendingDailyUsageRollupRepairs(db, { limit: 2 })).toMatchObject({
      claimed: 2,
      repaired: 2,
      failed: [],
    });

    expect(await dailyRows(user.id, null)).toEqual([{ usageDate: '2026-07-14', total: 11 }]);
    expect(await dailyRows(user.id, organization.id)).toEqual([
      { usageDate: '2026-07-14', total: 31 },
    ]);
  });

  test('uses signed costs and deletes a stale rollup when the canonical total is exactly zero', async () => {
    const user = await createUser();
    const createdAt = '2026-07-14T12:00:00.000Z';
    const firstUsageId = await insertRawUsage(user.id, 40, createdAt);
    await insertRawUsage(user.id, -40, createdAt);
    await db.insert(microdollar_usage_daily).values({
      kilo_user_id: user.id,
      organization_id: null,
      usage_date: '2026-07-14',
      total_cost_microdollars: 40,
    });

    await enqueueUsage(firstUsageId, user.id, createdAt);
    await processPendingDailyUsageRollupRepairs(db, { limit: 1 });

    expect(await dailyRows(user.id, null)).toEqual([]);
  });

  test('uses UTC day boundaries to create separate rollup keys', async () => {
    const user = await createUser();
    const firstCreatedAt = '2026-07-14T23:59:59.999Z';
    const secondCreatedAt = '2026-07-15T00:00:00.000Z';
    const firstUsageId = await insertRawUsage(user.id, 7, firstCreatedAt);
    const secondUsageId = await insertRawUsage(user.id, 13, secondCreatedAt);

    await enqueueUsage(firstUsageId, user.id, firstCreatedAt);
    await enqueueUsage(secondUsageId, user.id, secondCreatedAt);
    await processPendingDailyUsageRollupRepairs(db, { limit: 2 });

    expect(
      (await dailyRows(user.id, null)).sort((a, b) => a.usageDate.localeCompare(b.usageDate))
    ).toEqual([
      { usageDate: '2026-07-14', total: 7 },
      { usageDate: '2026-07-15', total: 13 },
    ]);
  });

  test('re-enqueueing an already repaired usage recomputes rather than double counting', async () => {
    const user = await createUser();
    const createdAt = '2026-07-14T12:00:00.000Z';
    const usageId = await insertRawUsage(user.id, 25, createdAt);

    await enqueueUsage(usageId, user.id, createdAt);
    await processPendingDailyUsageRollupRepairs(db, { limit: 1 });
    await enqueueUsage(usageId, user.id, createdAt);
    await processPendingDailyUsageRollupRepairs(db, { limit: 1 });

    expect(await dailyRows(user.id, null)).toEqual([{ usageDate: '2026-07-14', total: 25 }]);
  });

  test('rolls back raw usage and its repair signal with the source transaction', async () => {
    const user = await createUser();
    const usageId = crypto.randomUUID();
    const createdAt = '2026-07-14T12:00:00.000Z';

    await expect(
      db.transaction(async transaction => {
        await transaction.insert(microdollar_usage).values({
          id: usageId,
          kilo_user_id: user.id,
          organization_id: null,
          cost: 25,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: createdAt,
        });
        await enqueueDailyUsageRollupRepair(transaction, {
          usageId,
          kiloUserId: user.id,
          organizationId: null,
          createdAt,
        });
        throw new Error('source_transaction_failed');
      })
    ).rejects.toThrow('source_transaction_failed');

    expect(
      await db
        .select({ id: microdollar_usage.id })
        .from(microdollar_usage)
        .where(eq(microdollar_usage.id, usageId))
    ).toEqual([]);
    expect(
      await db
        .select({ usageId: microdollar_usage_daily_repairs.usage_id })
        .from(microdollar_usage_daily_repairs)
        .where(eq(microdollar_usage_daily_repairs.usage_id, usageId))
    ).toEqual([]);
  });

  test('retains failed repair work durably for a later retry', async () => {
    const user = await createUser();
    const createdAt = '2026-07-14T12:00:00.000Z';
    const usageId = await insertRawUsage(user.id, 25, createdAt);
    await enqueueUsage(usageId, user.id, createdAt);

    const [claim] = await claimPendingDailyUsageRollupRepairs(db, 1);
    expect(claim).toBeDefined();
    if (!claim) throw new Error('expected repair claim');
    await failDailyUsageRollupRepair(db, claim, 'simulated failure 55P03');

    const [repair] = await db
      .select({
        attemptCount: microdollar_usage_daily_repairs.attempt_count,
        claimedAt: microdollar_usage_daily_repairs.claimed_at,
        claimToken: microdollar_usage_daily_repairs.claim_token,
        lastError: microdollar_usage_daily_repairs.last_error_redacted,
      })
      .from(microdollar_usage_daily_repairs)
      .where(eq(microdollar_usage_daily_repairs.usage_id, usageId));
    expect(repair).toEqual({
      attemptCount: 1,
      claimedAt: null,
      claimToken: null,
      lastError: 'postgres:55P03',
    });
  });

  test('coalesces multiple pending repairs for one daily key into one canonical repair', async () => {
    const user = await createUser();
    const createdAt = '2026-07-14T12:00:00.000Z';
    const firstUsageId = await insertRawUsage(user.id, 11, createdAt);
    const secondUsageId = await insertRawUsage(user.id, 21, createdAt);

    await enqueueUsage(firstUsageId, user.id, createdAt);
    await enqueueUsage(secondUsageId, user.id, createdAt);
    expect(await processPendingDailyUsageRollupRepairs(db, { limit: 2 })).toEqual({
      claimed: 1,
      repaired: 1,
      failed: [],
    });

    expect(await dailyRows(user.id, null)).toEqual([{ usageDate: '2026-07-14', total: 32 }]);
    expect(
      await db
        .select({ usageId: microdollar_usage_daily_repairs.usage_id })
        .from(microdollar_usage_daily_repairs)
        .where(eq(microdollar_usage_daily_repairs.kilo_user_id, user.id))
    ).toEqual([]);
  });

  test('does not acknowledge same-key work owned by another repair snapshot', async () => {
    const user = await createUser();
    const createdAt = '2026-07-14T12:00:00.000Z';
    const firstUsageId = await insertRawUsage(user.id, 11, createdAt);
    const secondUsageId = await insertRawUsage(user.id, 21, createdAt);
    await enqueueUsage(firstUsageId, user.id, createdAt);
    await enqueueUsage(secondUsageId, user.id, createdAt);

    const [claimed] = await claimPendingDailyUsageRollupRepairs(db, 1);
    if (!claimed) throw new Error('expected repair claim');
    const laterUsageId = claimed.usage_id === firstUsageId ? secondUsageId : firstUsageId;
    const laterClaimToken = crypto.randomUUID();
    await db
      .update(microdollar_usage_daily_repairs)
      .set({ claimed_at: new Date().toISOString(), claim_token: laterClaimToken })
      .where(eq(microdollar_usage_daily_repairs.usage_id, laterUsageId));

    await expect(repairClaimedDailyUsageRollup(db, claimed)).resolves.toBe(true);

    expect(await dailyRows(user.id, null)).toEqual([{ usageDate: '2026-07-14', total: 32 }]);
    const remaining = await db
      .select({
        usageId: microdollar_usage_daily_repairs.usage_id,
        claimToken: microdollar_usage_daily_repairs.claim_token,
      })
      .from(microdollar_usage_daily_repairs)
      .where(eq(microdollar_usage_daily_repairs.kilo_user_id, user.id));
    expect(remaining).toEqual([{ usageId: laterUsageId, claimToken: laterClaimToken }]);
  });

  test('repairs every distinct key in a serial batch sharing one claim token', async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();
    const createdAt = '2026-07-14T12:00:00.000Z';
    const firstUsageId = await insertRawUsage(firstUser.id, 11, createdAt);
    const secondUsageId = await insertRawUsage(secondUser.id, 21, createdAt);
    await enqueueUsage(firstUsageId, firstUser.id, createdAt);
    await enqueueUsage(secondUsageId, secondUser.id, createdAt);

    await expect(
      processPendingDailyUsageRollupRepairs(db, { limit: 2, concurrency: 1 })
    ).resolves.toEqual({ claimed: 2, repaired: 2, failed: [] });

    expect(await dailyRows(firstUser.id, null)).toEqual([{ usageDate: '2026-07-14', total: 11 }]);
    expect(await dailyRows(secondUser.id, null)).toEqual([{ usageDate: '2026-07-14', total: 21 }]);
    const remaining = await db
      .select({ usageId: microdollar_usage_daily_repairs.usage_id })
      .from(microdollar_usage_daily_repairs)
      .where(inArray(microdollar_usage_daily_repairs.kilo_user_id, [firstUser.id, secondUser.id]));
    expect(remaining).toEqual([]);
  });
});
