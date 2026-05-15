import { microdollar_usage, type MicrodollarUsage } from '@kilocode/db/schema';
import {
  toInsertableDbUsageRecord,
  insertUsageRecord,
  type UsageContextInfo,
} from '@/lib/ai-gateway/processUsage';
import { db } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';
import { EmptyFraudDetectionHeaders } from '@/lib/utils';
import type {
  CoreUsageWithMetaData,
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@/lib/ai-gateway/processUsage.types';

function defineDefaultUsageStats(): MicrodollarUsageStats {
  return {
    messageId: `test-message-${Math.random()}`,
    model: 'anthropic/claude-3.7-sonnet',
    responseContent: 'test response',
    hasError: false,
    cost_mUsd: 1000, // 1000 microdollars = $0.001
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 0,
    cacheHitTokens: 0,
    is_byok: false,
    inference_provider: 'Provider',
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: 200,
  };
}

function defineDefaultContextInfo(): UsageContextInfo {
  return {
    kilo_user_id: `test-user-${Math.random()}`,
    organization_id: null,
    http_x_forwarded_for: 'nobody',
    http_x_vercel_ip_city: 'Test City',
    http_x_vercel_ip_country: 'Test Country',
    http_x_vercel_ip_latitude: 43,
    http_x_vercel_ip_longitude: -79,
    http_x_vercel_ja4_digest: 'normal_fingerprint',
    provider: 'openrouter',
    user_prompt_prefix: '<task>Implement a feature',
    system_prompt_prefix: 'You are Kilo Code, a highly skilled software engineer',
    system_prompt_length: 30000,
    http_user_agent: 'OpenAI/JS 1.0.0',
    max_tokens: 12345,
    has_middle_out_transform: true,
    project_id: null,
    requested_model: 'anthropic/claude-3.7-sonnet',
    status_code: 200,
    editor_name: null,
    api_kind: 'chat_completions',
    machine_id: null,
    is_user_byok: false,
    has_tools: false,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    ttfb_ms: null,
  };
}

// Returns structured type for new usage
export function defineMicrodollarUsage(): CoreUsageWithMetaData {
  const stats = defineDefaultUsageStats();
  const context = defineDefaultContextInfo();
  const result = toInsertableDbUsageRecord(stats, context);

  return {
    core: { ...result.core, created_at: '2025-08-15T12:00:00Z' },
    metadata: result.metadata,
  };
}

// Helper to insert usage record with overrides - used in tests
export async function insertUsageWithOverrides(
  overrides: Partial<MicrodollarUsage>
): Promise<void> {
  const { core, metadata } = defineMicrodollarUsage();
  await insertUsageRecord({ ...core, ...overrides }, metadata);
}

export function createMockUsageContext(
  kiloUserId: string,
  posthog_distinct_id: string,
  prior_microdollar_usage: number
): MicrodollarUsageContext {
  return {
    api_kind: 'chat_completions',
    kiloUserId,
    fraudHeaders: EmptyFraudDetectionHeaders,
    provider: 'openrouter',
    requested_model: 'test-model',
    promptInfo: {
      system_prompt_prefix: '',
      system_prompt_length: 0,
      user_prompt_prefix: '',
    },
    max_tokens: null,
    has_middle_out_transform: null,
    isStreaming: false,
    prior_microdollar_usage,
    posthog_distinct_id,
    project_id: null,
    status_code: 200,
    editor_name: null,
    machine_id: null,
    user_byok: false,
    has_tools: false,
    feature: 'vscode-extension',
    session_id: null,
    mode: null,
    auto_model: null,
    ttfb_ms: null,
  };
}

export function createOrganizationUsage(
  cost: number,
  kilo_user_id: string,
  organization_id: string
): MicrodollarUsage {
  const { core } = defineMicrodollarUsage();
  return { ...core, kilo_user_id, cost, organization_id };
}

/**
 * Insert raw microdollar_usage rows AND bump the matching microdollar_usage_daily
 * counters in a single statement, mirroring the dual-write that production
 * performs in insertUsageAndMetadataWithBalanceUpdate.
 *
 * Use this in tests that exercise queries against microdollar_usage_daily
 * (e.g. kiloPass.getAverageMonthlyUsageLast3Months). For tests that only
 * read microdollar_usage directly, plain db.insert(microdollar_usage) is fine.
 */
export async function insertMicrodollarUsageWithDailyRollup(
  rows: (typeof microdollar_usage.$inferInsert)[]
): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction(async tx => {
    await tx.insert(microdollar_usage).values(rows);
    for (const row of rows) {
      if (!row.cost || row.cost === 0) continue;
      const dailyConflictTarget = row.organization_id
        ? sql`(kilo_user_id, organization_id, usage_date) WHERE organization_id IS NOT NULL`
        : sql`(kilo_user_id, usage_date) WHERE organization_id IS NULL`;
      await tx.execute(sql`
        INSERT INTO microdollar_usage_daily (
          kilo_user_id, organization_id, usage_date, total_cost_microdollars
        )
        SELECT
          ${row.kilo_user_id},
          ${row.organization_id ?? null}::uuid,
          date_trunc('day', ${row.created_at ?? sql`NOW()`}::timestamptz)::date,
          ${row.cost}::bigint
        ON CONFLICT ${dailyConflictTarget}
        DO UPDATE SET
          total_cost_microdollars =
            microdollar_usage_daily.total_cost_microdollars + EXCLUDED.total_cost_microdollars,
          updated_at = NOW()
      `);
    }
  });
}
