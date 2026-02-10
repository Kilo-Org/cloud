import type { MicrodollarUsage } from '@/db/schema';
import {
  toInsertableDbUsageRecord,
  insertUsageRecord,
  type MicrodollarUsageStats,
  type MicrodollarUsageContext,
  type UsageContextInfo,
  type CoreUsageWithMetaData,
} from '@/lib/processUsage';
import { EmptyFraudDetectionHeaders } from '@/lib/utils';

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
    machine_id: null,
    is_user_byok: false,
    has_tools: false,
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
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    isStreaming: false,
    prior_microdollar_usage,
    posthog_distinct_id,
    project_id: null,
    status_code: 200,
    editor_name: null,
    machine_id: null,
    user_byok: false,
    has_tools: false,
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
