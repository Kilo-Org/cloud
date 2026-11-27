import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { KiloOrganizationId } from './schema-types';
import {
  UsageRecordRequestSchema,
  UsageRecordResponseSchema,
  toUsageRecordWireBody,
} from './index';

const RETIRED_METADATA_KEYS = [
  'user_prompt_prefix',
  'system_prompt_prefix',
  'abuse_delay',
  'abuse_downgraded_from',
] as const;

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
    // Typed wider than the literal so tests can exercise accepted and rejected
    // organization_id shapes.
    organization_id: null as KiloOrganizationId | null,
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
    reasoning_setting: null as string | null,
    market_cost: null,
    is_free: null,
    system_prompt_kind: null,
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

  test.each([null, 'effort:high', 'thinking:enabled:le64k'])(
    'preserves reasoning_setting %s',
    reasoningSetting => {
      const request = validRequest();
      request.metadata.reasoning_setting = reasoningSetting;
      expect(UsageRecordRequestSchema.parse(request).metadata.reasoning_setting).toBe(
        reasoningSetting
      );
    }
  );

  test('defaults absent reasoning_setting from older gateway senders to null', () => {
    const request = validRequest();
    delete (request.metadata as Record<string, unknown>).reasoning_setting;
    expect(UsageRecordRequestSchema.parse(request).metadata.reasoning_setting).toBeNull();
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

  // JSON.stringify drops undefined-valued keys, so a missing key must fail rather
  // than reach the INSERT as undefined.
  test.each(['http_x_forwarded_for', 'api_kind', 'finish_reason'])(
    'rejects metadata with %s absent rather than explicitly null',
    field => {
      const request = validRequest();
      delete (request.metadata as Record<string, unknown>)[field];
      expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
    }
  );

  test('rejects a nullable core column that is absent', () => {
    const request = validRequest();
    delete (request.core as Record<string, unknown>).cache_discount;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test.each([
    ['null', null, null, null, null],
    ['legacy strings', '🙂 hello', 'You are helpful', 12.5, 'anthropic/claude-opus-5'],
  ])(
    'accepts and strips the retired metadata keys from an older sender with %s',
    (_label, userPromptPrefix, systemPromptPrefix, abuseDelay, abuseDowngradedFrom) => {
      const request = {
        ...validRequest(),
        metadata: {
          ...validMetadata(),
          user_prompt_prefix: userPromptPrefix,
          system_prompt_prefix: systemPromptPrefix,
          abuse_delay: abuseDelay,
          abuse_downgraded_from: abuseDowngradedFrom,
        },
      };
      const parsed = UsageRecordRequestSchema.parse(request);
      expect(parsed.metadata).toEqual(UsageRecordRequestSchema.parse(validRequest()).metadata);
      for (const key of RETIRED_METADATA_KEYS) expect(parsed.metadata).not.toHaveProperty(key);
    }
  );

  describe('toUsageRecordWireBody', () => {
    // The schema before the retirement: older receivers still require these keys.
    const PreRetirementRequestSchema = UsageRecordRequestSchema.extend({
      metadata: UsageRecordRequestSchema.shape.metadata.extend({
        user_prompt_prefix: z.string().nullable(),
        system_prompt_prefix: z.string().nullable(),
        abuse_delay: z.number().nullable(),
        abuse_downgraded_from: z.string().nullable(),
      }),
    });

    test('satisfies a receiver that still requires the retired keys', () => {
      const body = toUsageRecordWireBody(UsageRecordRequestSchema.parse(validRequest()));
      expect(PreRetirementRequestSchema.safeParse(JSON.parse(JSON.stringify(body))).success).toBe(
        true
      );
      for (const key of RETIRED_METADATA_KEYS) expect(body.metadata[key]).toBeNull();
    });

    test('is still accepted by the current schema, without the retired keys', () => {
      const body = toUsageRecordWireBody(UsageRecordRequestSchema.parse(validRequest()));
      const parsed = UsageRecordRequestSchema.parse(body);
      for (const key of RETIRED_METADATA_KEYS) expect(parsed.metadata).not.toHaveProperty(key);
    });

    test('a body without the helper fails the pre-retirement schema', () => {
      expect(PreRetirementRequestSchema.safeParse(validRequest()).success).toBe(false);
    });
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

  test('rejects a fractional market_cost', () => {
    const request = validRequest();
    (request.metadata as Record<string, unknown>).market_cost = 12.5;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('rejects a market_cost beyond safe integer range', () => {
    const request = validRequest();
    (request.metadata as Record<string, unknown>).market_cost = Number.MAX_SAFE_INTEGER + 2;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('rejects a fractional prior_microdollar_usage', () => {
    const request = validRequest();
    request.prior_microdollar_usage = 12.5;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('rejects a prior_microdollar_usage beyond safe integer range', () => {
    const request = validRequest();
    request.prior_microdollar_usage = Number.MAX_SAFE_INTEGER + 2;
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });

  test('accepts System One usage for primary-region billing', () => {
    const request = validRequest();
    request.metadata.api_kind = 'systemone';
    expect(UsageRecordRequestSchema.parse(request).metadata.api_kind).toBe('systemone');
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

  // `organization_id` follows the `organizations.id` column contract: every
  // stored id passes, so a stored organization whose id is column-shaped but
  // not RFC-versioned must not be rejected here.
  test('accepts a column-shaped organization_id that is not an RFC UUID', () => {
    const request = validRequest();
    request.core.organization_id = '4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f';
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(true);
  });

  test('rejects a string that is not an 8-4-4-4-12 GUID as organization_id', () => {
    const request = validRequest();
    request.core.organization_id = 'org-456';
    expect(UsageRecordRequestSchema.safeParse(request).success).toBe(false);
  });
});

function validResponse() {
  return {
    status: 'recorded',
    result: {
      usageId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      // A DB read-back shape stays a plain string: see packages/db/AGENTS.md
      // "Timestamp boundaries".
      createdAt: '2026-08-05T10:11:12.945Z',
      newMicrodollarsUsed: 42,
    },
  };
}

describe('UsageRecordResponseSchema', () => {
  test('accepts a recorded writer reply', () => {
    expect(UsageRecordResponseSchema.parse(validResponse())).toEqual(validResponse());
  });

  test('accepts a not_recorded reply with a null result', () => {
    expect(UsageRecordResponseSchema.parse({ status: 'not_recorded', result: null })).toEqual({
      status: 'not_recorded',
      result: null,
    });
  });

  test('rejects a recorded reply with a null result', () => {
    expect(UsageRecordResponseSchema.safeParse({ status: 'recorded', result: null }).success).toBe(
      false
    );
  });

  test('rejects a duplicate reply with a null result', () => {
    expect(UsageRecordResponseSchema.safeParse({ status: 'duplicate', result: null }).success).toBe(
      false
    );
  });

  test('rejects a not_recorded reply that carries a result', () => {
    expect(
      UsageRecordResponseSchema.safeParse({
        status: 'not_recorded',
        result: validResponse().result,
      }).success
    ).toBe(false);
  });

  test('rejects a non-UUID usageId in the result', () => {
    const response = validResponse();
    response.result.usageId = 'usage-1';
    expect(UsageRecordResponseSchema.safeParse(response).success).toBe(false);
  });

  test('accepts a DB-shaped createdAt string', () => {
    const response = validResponse();
    response.result.createdAt = '2026-04-29 01:16:12.945+00';
    expect(UsageRecordResponseSchema.safeParse(response).success).toBe(true);
  });
});
