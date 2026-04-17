import { describe, test, expect } from '@jest/globals';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createMockUsageContext } from '@/tests/helpers/microdollar-usage.helper';
import { db } from '@/lib/drizzle';
import { kilocode_users, microdollar_usage } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  insertUsageRecord,
  toInsertableDbUsageRecord,
  extractUsageContextInfo,
} from './ai-gateway/processUsage';
import type { MicrodollarUsageStats } from './ai-gateway/processUsage.types';

function createMockUsageStats(cost_mUsd: number): MicrodollarUsageStats {
  return {
    messageId: `msg-${Date.now()}`,
    model: 'test-model',
    responseContent: 'test response',
    hasError: false,
    inference_provider: 'test-provider',
    cost_mUsd,
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 0,
    cacheHitTokens: 0,
    is_byok: false,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
  };
}

describe('Usage deduction for migrated users', () => {
  test('should update microdollars_used when recording usage', async () => {
    const initialMicrodollarsUsed = 100_000; // 0.1 USD
    const user = await insertTestUser({
      microdollars_used: initialMicrodollarsUsed,
      total_microdollars_acquired: 1_000_000, // 1 USD
    });

    const usageCost = 50_000; // 0.05 USD in microdollars (50 mUSD)
    const usageStats = createMockUsageStats(usageCost);
    const usageContext = createMockUsageContext(
      user.id,
      user.google_user_email,
      initialMicrodollarsUsed
    );

    const contextInfo = extractUsageContextInfo(usageContext);
    const { core, metadata } = toInsertableDbUsageRecord(usageStats, contextInfo);

    const result = await insertUsageRecord(core, metadata);

    expect(result).not.toBeNull();
    expect(result?.newMicrodollarsUsed).toBe(initialMicrodollarsUsed + usageCost);

    // Verify user's microdollars_used was updated in DB
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.microdollars_used).toBe(initialMicrodollarsUsed + usageCost);
  });

  test('should correctly record usage for user with zero prior usage', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 500_000, // 0.5 USD
    });

    const usageCost = 10_000; // 0.01 USD
    const usageStats = createMockUsageStats(usageCost);
    const usageContext = createMockUsageContext(user.id, user.google_user_email, 0);

    const contextInfo = extractUsageContextInfo(usageContext);
    const { core, metadata } = toInsertableDbUsageRecord(usageStats, contextInfo);

    const result = await insertUsageRecord(core, metadata);

    expect(result).not.toBeNull();
    expect(result?.newMicrodollarsUsed).toBe(usageCost);

    // Verify usage record was created
    const usageRecords = await db.query.microdollar_usage.findMany({
      where: eq(microdollar_usage.kilo_user_id, user.id),
    });
    expect(usageRecords.length).toBe(1);
    expect(usageRecords[0].cost).toBe(usageCost);
  });

  test('should handle multiple sequential usage records', async () => {
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });

    const costs = [10_000, 20_000, 15_000];
    let currentUsage = 0;

    for (const cost of costs) {
      const usageStats = createMockUsageStats(cost);
      const usageContext = createMockUsageContext(user.id, user.google_user_email, currentUsage);

      const contextInfo = extractUsageContextInfo(usageContext);
      const { core, metadata } = toInsertableDbUsageRecord(usageStats, contextInfo);

      const result = await insertUsageRecord(core, metadata);
      expect(result).not.toBeNull();

      currentUsage += cost;
      expect(result?.newMicrodollarsUsed).toBe(currentUsage);
    }

    // Verify final state
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.microdollars_used).toBe(45_000); // 10k + 20k + 15k
  });

  test('should correctly compute balance after usage deduction', async () => {
    const totalAcquired = 1_000_000; // 1 USD
    const user = await insertTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: totalAcquired,
    });

    const usageCost = 250_000; // 0.25 USD
    const usageStats = createMockUsageStats(usageCost);
    const usageContext = createMockUsageContext(user.id, user.google_user_email, 0);

    const contextInfo = extractUsageContextInfo(usageContext);
    const { core, metadata } = toInsertableDbUsageRecord(usageStats, contextInfo);

    await insertUsageRecord(core, metadata);

    // Verify balance calculation
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });

    const expectedBalance = (totalAcquired - (updatedUser?.microdollars_used ?? 0)) / 1_000_000;
    expect(expectedBalance).toBe(0.75); // 1 USD - 0.25 USD = 0.75 USD
  });
});
