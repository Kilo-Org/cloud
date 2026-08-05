import { describe, expect, test } from '@jest/globals';

import { UsageRecordRequestSchema } from './usage-record-contract';

function validCore() {
  return {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    kilo_user_id: 'user-1',
    cost: 1234,
    input_tokens: 10,
    output_tokens: 20,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: '2026-08-05T10:11:12.945Z',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-5',
    requested_model: 'anthropic/claude-opus-5',
    cache_discount: null,
    has_error: false,
    abuse_classification: 0,
    organization_id: null,
    inference_provider: null,
    project_id: null,
  };
}

function validMetadata() {
  return {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    message_id: 'msg-1',
    created_at: '2026-08-05T10:11:12.945Z',
    http_x_forwarded_for: null,
    http_x_vercel_ip_city: null,
    http_x_vercel_ip_country: null,
    http_x_vercel_ip_latitude: null,
    http_x_vercel_ip_longitude: null,
    http_x_vercel_ja4_digest: null,
    user_prompt_prefix: null,
    system_prompt_prefix: null,
    system_prompt_length: null,
    http_user_agent: null,
    max_tokens: null,
    has_middle_out_transform: null,
    status_code: 200,
    upstream_id: null,
    finish_reason: 'stop',
    latency: null,
    moderation_latency: null,
    generation_time: null,
    is_byok: null,
    is_user_byok: false,
    streamed: null,
    cancelled: null,
    editor_name: null,
    api_kind: 'chat_completions',
    has_tools: null,
    machine_id: null,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    market_cost: null,
    is_free: null,
    abuse_delay: null,
    abuse_downgraded_from: null,
  };
}

function validRequest() {
  return {
    core: validCore(),
    metadata: validMetadata(),
    prior_microdollar_usage: 0,
    posthog_distinct_id: null,
  };
}

describe('UsageRecordRequestSchema', () => {
  test('accepts a well-formed payload', () => {
    expect(UsageRecordRequestSchema.safeParse(validRequest()).success).toBe(true);
  });

  // Required by packages/db/AGENTS.md "Timestamp boundaries": PostgreSQL
  // timestamptz text is not strict ISO 8601, and must never enter this contract.
  // The sender uses new Date().toISOString(); a DB-read value would silently
  // shift day bucketing in enqueueDailyUsageRollupRepair.
  test.each([
    ['production-shaped PostgreSQL timestamptz', '2026-04-29 01:16:12.945+00'],
    ['PostgreSQL timestamptz without fractional seconds', '2026-04-29 01:16:12+00'],
    ['space-separated with no offset', '2026-04-29 01:16:12'],
  ])('rejects %s in core.created_at', (_label, timestamp) => {
    const request = validRequest();
    request.core.created_at = timestamp;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('rejects production-shaped PostgreSQL timestamptz in metadata.created_at', () => {
    const request = validRequest();
    request.metadata.created_at = '2026-04-29 01:16:12.945+00';
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  // JSON.stringify drops undefined-valued keys. For organization usage,
  // toInsertableDbUsageRecord sets the prompt prefixes to null precisely so
  // prompt text is never persisted, so a missing key must fail rather than reach
  // the INSERT as undefined.
  test.each([
    'user_prompt_prefix',
    'system_prompt_prefix',
    'http_x_forwarded_for',
    'api_kind',
    'finish_reason',
  ])('rejects metadata with %s absent rather than explicitly null', field => {
    const request = validRequest();
    delete (request.metadata as Record<string, unknown>)[field];
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('rejects a nullable core column that is absent', () => {
    const request = validRequest();
    delete (request.core as Record<string, unknown>).cache_discount;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('preserves an explicit null prompt prefix', () => {
    const parsed = UsageRecordRequestSchema.parse(validRequest());
    expect(parsed.metadata.user_prompt_prefix).toBeNull();
    expect(parsed.metadata.system_prompt_prefix).toBeNull();
  });

  test('rejects a non-integer cost', () => {
    const request = validRequest();
    request.core.cost = 12.5;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('rejects a cost beyond safe integer range', () => {
    const request = validRequest();
    request.core.cost = Number.MAX_SAFE_INTEGER + 2;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('accepts negative cost, which refunds rely on', () => {
    const request = validRequest();
    request.core.cost = -500;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(true);
  });

  test('rejects an unknown api_kind', () => {
    const request = validRequest();
    request.metadata.api_kind = 'not_a_real_kind';
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('rejects an unknown abuse_classification', () => {
    const request = validRequest();
    request.core.abuse_classification = 7;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('accepts every real abuse_classification value', () => {
    for (const value of [-100, -50, 0, 200]) {
      const request = validRequest();
      request.core.abuse_classification = value;
      expect(UsageRecordRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  test('survives a JSON round trip, which is how it travels', () => {
    const request = validRequest();
    const roundTripped: unknown = JSON.parse(JSON.stringify(request));
    expect(UsageRecordRequestSchema.safeParse(roundTripped).success).toBe(true);
  });
});
