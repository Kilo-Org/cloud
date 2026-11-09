import { describe, expect, test } from 'vitest';

import {
  ENKRYPT_USAGE_WRITE_PATH,
  EnkryptUsageWriteResponseSchema,
  EnkryptUsageWriteSchema,
  MAX_ENKRYPT_CREDITS_PER_CALL,
} from './index';

function validWrite(): Record<string, unknown> {
  return {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    occurredAt: '2026-11-06T12:00:00.000Z',
    organizationId: '9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e',
    kiloUserId: 'oauth/github:12345',
    sessionId: 'ses_guardrail',
    microdollarUsageId: '6c1f0a2b-3d4e-4f5a-8b6c-7d8e9f0a1b2c',
    apiKind: 'messages',
    decision: 'blocked',
    creditsCost: 7,
    addedLatencyMs: 212,
    guardrail: 'output',
  };
}

function writeWith(overrides: Record<string, unknown>) {
  return { ...validWrite(), ...overrides };
}

function writeWithout(key: string) {
  const write = validWrite();
  delete write[key];
  return write;
}

describe('EnkryptUsageWriteSchema', () => {
  test('exposes the internal writer path', () => {
    expect(ENKRYPT_USAGE_WRITE_PATH).toBe('/api/internal/enkrypt-usage/record');
  });

  test('accepts a well-formed output guardrail write', () => {
    expect(EnkryptUsageWriteSchema.parse(validWrite())).toStrictEqual(validWrite());
  });

  test('survives a JSON round trip, which is how it travels', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(validWrite()));
    expect(EnkryptUsageWriteSchema.parse(roundTripped)).toStrictEqual(validWrite());
  });

  test('defaults an omitted guardrail to input', () => {
    expect(EnkryptUsageWriteSchema.parse(writeWithout('guardrail'))).toStrictEqual(
      writeWith({ guardrail: 'input' })
    );
  });

  test('accepts a write without an inference usage id or credits', () => {
    const write = writeWith({ creditsCost: null, addedLatencyMs: null, sessionId: null });
    delete write.microdollarUsageId;
    expect(EnkryptUsageWriteSchema.parse(write)).toStrictEqual(write);
  });

  test.each([
    ['a non-RFC variant', '4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f'],
    ['a non-RFC version', '9b2d7c4e-1f3a-0b5c-8d6e-7f8a9b0c1d2e'],
    ['the nil GUID', '00000000-0000-0000-0000-000000000000'],
    ['upper case', '9B2D7C4E-1F3A-4B5C-8D6E-7F8A9B0C1D2E'],
  ])('accepts a GUID with %s as organizationId', (_label, organizationId) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ organizationId })).success).toBe(true);
  });

  test('keeps organizationId looser than the strict UUID usage id', () => {
    const guid = '4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f';
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ organizationId: guid })).success).toBe(
      true
    );
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ id: guid })).success).toBe(false);
  });

  test.each([
    ['an empty string', ''],
    ['a non-GUID string', 'org-456'],
    ['a GUID with surrounding whitespace', ' 9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e '],
    ['null', null],
  ])('rejects %s as organizationId', (_label, organizationId) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ organizationId })).success).toBe(false);
  });

  test.each([
    'id',
    'occurredAt',
    'organizationId',
    'kiloUserId',
    'sessionId',
    'apiKind',
    'decision',
    'creditsCost',
    'addedLatencyMs',
  ])('rejects a write without %s', key => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWithout(key)).success).toBe(false);
  });

  test.each([
    ['prompt', 'secret text'],
    ['usageId', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    ['kilo_user_id', 'user-1'],
    ['organization_id', '9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e'],
  ])('rejects the unknown key %s', (key, value) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ [key]: value })).success).toBe(false);
  });

  test('rejects an LLM usage record', () => {
    const llmRecord = {
      core: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', kilo_user_id: 'user-1', cost: 1 },
      metadata: {},
      prior_microdollar_usage: 0,
      posthog_distinct_id: null,
    };
    expect(EnkryptUsageWriteSchema.safeParse(llmRecord).success).toBe(false);
  });

  test.each([
    ['id', 'usage-1'],
    ['microdollarUsageId', 'usage-1'],
    ['microdollarUsageId', null],
  ])('rejects %s as %j', (key, value) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ [key]: value })).success).toBe(false);
  });

  test.each([
    ['a positive offset', '2026-11-06T13:00:00.000+01:00'],
    ['no fractional seconds', '2026-11-06T12:00:00Z'],
  ])('accepts occurredAt with %s', (_label, occurredAt) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ occurredAt })).success).toBe(true);
  });

  test.each([
    ['production-shaped PostgreSQL timestamptz', '2026-04-29 01:16:12.945+00'],
    ['no offset', '2026-11-06T12:00:00.000'],
    ['epoch milliseconds', 1_793_966_400_000],
  ])('rejects occurredAt as %s', (_label, occurredAt) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ occurredAt })).success).toBe(false);
  });

  test('rejects an empty kiloUserId', () => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ kiloUserId: '' })).success).toBe(false);
  });

  test.each(['chat_completions', 'messages', 'responses'])('accepts the api kind %s', apiKind => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ apiKind })).success).toBe(true);
  });

  test.each(['embeddings', 'fim_completions', ''])('rejects the api kind %j', apiKind => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ apiKind })).success).toBe(false);
  });

  test.each(['allowed', 'blocked', 'error'])('accepts the decision %s', decision => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ decision })).success).toBe(true);
  });

  test.each(['maybe', ''])('rejects the decision %j', decision => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ decision })).success).toBe(false);
  });

  test('accepts the detectors that fired', () => {
    const write = writeWith({ decision: 'allowed', detectorsFired: ['pii', 'toxicity'] });
    expect(EnkryptUsageWriteSchema.parse(write)).toStrictEqual(write);
  });

  test('leaves omitted detectors absent', () => {
    expect(EnkryptUsageWriteSchema.parse(validWrite())).not.toHaveProperty('detectorsFired');
  });

  test.each([
    ['an empty list', []],
    ['an unknown detector', ['system_prompt_similarity']],
    ['null', null],
    ['a single detector string', 'pii'],
  ])('rejects %s as detectorsFired', (_label, detectorsFired) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ detectorsFired })).success).toBe(false);
  });

  test.each(['both', 'Input', null])('rejects the guardrail %j', guardrail => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ guardrail })).success).toBe(false);
  });

  test.each([
    ['zero', 0],
    ['fractional', 2.5],
    ['the per-call maximum', MAX_ENKRYPT_CREDITS_PER_CALL],
  ])('accepts %s credits', (_label, creditsCost) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ creditsCost })).success).toBe(true);
  });

  test.each([
    ['negative', -1],
    ['above the per-call maximum', MAX_ENKRYPT_CREDITS_PER_CALL + 1],
    ['fractionally above the per-call maximum', MAX_ENKRYPT_CREDITS_PER_CALL + 0.5],
    ['a numeric string', '7'],
  ])('rejects %s credits', (_label, creditsCost) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ creditsCost })).success).toBe(false);
  });

  test('caps credits at 1,000 per call', () => {
    expect(MAX_ENKRYPT_CREDITS_PER_CALL).toBe(1_000);
  });

  test.each([
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a %s addedLatencyMs', (_label, addedLatencyMs) => {
    expect(EnkryptUsageWriteSchema.safeParse(writeWith({ addedLatencyMs })).success).toBe(false);
  });
});

describe('EnkryptUsageWriteResponseSchema', () => {
  test.each(['recorded', 'duplicate'])('accepts %s', status => {
    expect(EnkryptUsageWriteResponseSchema.parse({ status })).toStrictEqual({ status });
  });

  test.each([
    ['an unknown status', { status: 'not_recorded' }],
    ['a missing status', {}],
    ['an echoed usage id', { status: 'recorded', usageId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }],
    ['an extra key', { status: 'duplicate', result: null }],
  ])('rejects %s', (_label, body) => {
    expect(EnkryptUsageWriteResponseSchema.safeParse(body).success).toBe(false);
  });
});
