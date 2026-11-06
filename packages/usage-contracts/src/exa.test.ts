import { describe, expect, test } from 'vitest';

import {
  EXA_ALLOWED_PATHS,
  EXA_USAGE_FEATURE_ID_MAX_LENGTH,
  EXA_USAGE_TYPE_MAX_LENGTH,
  EXA_USAGE_WRITE_PATH,
  ExaUsageRecordSchema,
  ExaUsageWriteResponseSchema,
  isExaAllowedPath,
  UsageRecordRequestSchema,
} from './index';

function validRecord(): Record<string, unknown> {
  return {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    occurredAt: '2026-11-06T12:00:00.000Z',
    userId: 'oauth/github:12345',
    organizationId: '9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e',
    path: '/search',
    costMicrodollars: 7000,
    chargedToBalance: true,
    freeAllowanceMicrodollars: 10_000_000,
    featureId: 'kiloclaw',
    type: 'deep',
  };
}

function recordWith(overrides: Record<string, unknown>) {
  return { ...validRecord(), ...overrides };
}

function recordWithout(key: string) {
  const record = validRecord();
  delete record[key];
  return record;
}

describe('ExaUsageRecordSchema', () => {
  test('exposes the internal writer path', () => {
    expect(EXA_USAGE_WRITE_PATH).toBe('/api/internal/exa-usage/record');
  });

  test('accepts a well-formed organization record', () => {
    expect(ExaUsageRecordSchema.parse(validRecord())).toEqual(validRecord());
  });

  test('accepts a personal record with a null organization and no optional fields', () => {
    const record = recordWith({ organizationId: null, chargedToBalance: false });
    delete record.featureId;
    delete record.type;
    expect(ExaUsageRecordSchema.parse(record)).toEqual(record);
  });

  test('survives a JSON round trip, which is how it travels', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(validRecord()));
    expect(ExaUsageRecordSchema.parse(roundTripped)).toEqual(validRecord());
  });

  test.each([
    ['an empty string', ''],
    ['a non-UUID string', 'org-456'],
    ['a UUID with a non-RFC variant', '4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f'],
    ['a UUID with surrounding whitespace', ' 9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e '],
  ])('rejects %s as organizationId', (_label, organizationId) => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ organizationId })).success).toBe(false);
  });

  test('rejects an absent organizationId rather than treating it as personal', () => {
    expect(ExaUsageRecordSchema.safeParse(recordWithout('organizationId')).success).toBe(false);
  });

  test.each([
    'id',
    'occurredAt',
    'userId',
    'path',
    'costMicrodollars',
    'chargedToBalance',
    'freeAllowanceMicrodollars',
  ])('rejects a record without %s', key => {
    expect(ExaUsageRecordSchema.safeParse(recordWithout(key)).success).toBe(false);
  });

  test.each([
    ['input_tokens', 10],
    ['provider', 'openrouter'],
    ['model', 'anthropic/claude-opus-5'],
    ['kilo_user_id', 'user-1'],
    ['organization_id', null],
  ])('rejects the unknown LLM-style key %s', (key, value) => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ [key]: value })).success).toBe(false);
  });

  test('rejects an LLM usage record', () => {
    const llmRecord = {
      core: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', kilo_user_id: 'user-1', cost: 1 },
      metadata: {},
      prior_microdollar_usage: 0,
      posthog_distinct_id: null,
    };
    expect(ExaUsageRecordSchema.safeParse(llmRecord).success).toBe(false);
  });

  test('is not accepted by the LLM usage record schema', () => {
    expect(UsageRecordRequestSchema.safeParse(validRecord()).success).toBe(false);
  });

  test('rejects a non-UUID id', () => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ id: 'usage-1' })).success).toBe(false);
  });

  test.each([
    ['UTC with milliseconds', '2026-11-06T12:00:00.000Z'],
    ['a positive offset', '2026-11-06T13:00:00.000+01:00'],
    ['no fractional seconds', '2026-11-06T12:00:00Z'],
  ])('accepts occurredAt in ISO 8601 with %s', (_label, occurredAt) => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ occurredAt })).success).toBe(true);
  });

  test.each([
    ['production-shaped PostgreSQL timestamptz', '2026-04-29 01:16:12.945+00'],
    ['no offset', '2026-11-06T12:00:00.000'],
    ['a date only', '2026-11-06'],
    ['epoch milliseconds', 1_793_966_400_000],
  ])('rejects occurredAt as %s', (_label, occurredAt) => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ occurredAt })).success).toBe(false);
  });

  test('rejects an empty userId', () => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ userId: '' })).success).toBe(false);
  });

  test.each(EXA_ALLOWED_PATHS)('accepts the allowed path %s', path => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ path })).success).toBe(true);
  });

  test.each(['/badpath', 'search', '/search/', '/api/exa/search', ''])(
    'rejects the path %j',
    path => {
      expect(ExaUsageRecordSchema.safeParse(recordWith({ path })).success).toBe(false);
    }
  );

  test.each([
    ['zero', 0],
    ['negative', -7000],
    ['fractional', 70.5],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
    ['a numeric string', '7000'],
  ])('rejects a %s costMicrodollars', (_label, costMicrodollars) => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ costMicrodollars })).success).toBe(false);
  });

  test('accepts the largest safe integer cost', () => {
    const record = recordWith({ costMicrodollars: Number.MAX_SAFE_INTEGER });
    expect(ExaUsageRecordSchema.safeParse(record).success).toBe(true);
  });

  test('accepts a zero free allowance', () => {
    const record = recordWith({ freeAllowanceMicrodollars: 0 });
    expect(ExaUsageRecordSchema.safeParse(record).success).toBe(true);
  });

  test.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects a %s freeAllowanceMicrodollars', (_label, freeAllowanceMicrodollars) => {
    const record = recordWith({ freeAllowanceMicrodollars });
    expect(ExaUsageRecordSchema.safeParse(record).success).toBe(false);
  });

  test('rejects a non-boolean chargedToBalance', () => {
    const record = recordWith({ chargedToBalance: 'true' });
    expect(ExaUsageRecordSchema.safeParse(record).success).toBe(false);
  });

  test('bounds featureId', () => {
    const atLimit = 'f'.repeat(EXA_USAGE_FEATURE_ID_MAX_LENGTH);
    const overLimit = 'f'.repeat(EXA_USAGE_FEATURE_ID_MAX_LENGTH + 1);
    expect(ExaUsageRecordSchema.safeParse(recordWith({ featureId: atLimit })).success).toBe(true);
    expect(ExaUsageRecordSchema.safeParse(recordWith({ featureId: overLimit })).success).toBe(
      false
    );
    expect(ExaUsageRecordSchema.safeParse(recordWith({ featureId: '' })).success).toBe(false);
  });

  test('bounds type and keeps an empty client value', () => {
    const atLimit = 't'.repeat(EXA_USAGE_TYPE_MAX_LENGTH);
    const overLimit = 't'.repeat(EXA_USAGE_TYPE_MAX_LENGTH + 1);
    expect(ExaUsageRecordSchema.safeParse(recordWith({ type: atLimit })).success).toBe(true);
    expect(ExaUsageRecordSchema.safeParse(recordWith({ type: overLimit })).success).toBe(false);
    expect(ExaUsageRecordSchema.safeParse(recordWith({ type: '' })).success).toBe(true);
  });

  test.each([
    ['featureId', null],
    ['type', null],
  ])('rejects a null %s; senders omit it instead', (key, value) => {
    expect(ExaUsageRecordSchema.safeParse(recordWith({ [key]: value })).success).toBe(false);
  });
});

describe('isExaAllowedPath', () => {
  test('matches exactly the allowlist', () => {
    for (const path of EXA_ALLOWED_PATHS) expect(isExaAllowedPath(path)).toBe(true);
    expect(isExaAllowedPath('/badpath')).toBe(false);
    expect(isExaAllowedPath('/Search')).toBe(false);
  });
});

describe('ExaUsageWriteResponseSchema', () => {
  const usageId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  test.each(['recorded', 'duplicate'])('accepts %s', status => {
    expect(ExaUsageWriteResponseSchema.parse({ status, usageId })).toEqual({ status, usageId });
  });

  test.each([
    ['an unknown status', { status: 'not_recorded', usageId }],
    ['a missing usageId', { status: 'recorded' }],
    ['a non-UUID usageId', { status: 'recorded', usageId: 'usage-1' }],
    ['a missing status', { usageId }],
    ['an extra key', { status: 'recorded', usageId, result: null }],
    [
      'the LLM writer response shape',
      { status: 'recorded', result: { usageId, createdAt: '', newMicrodollarsUsed: null } },
    ],
  ])('rejects %s', (_label, body) => {
    expect(ExaUsageWriteResponseSchema.safeParse(body).success).toBe(false);
  });
});
