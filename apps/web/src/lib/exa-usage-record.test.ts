import { describe, it, expect } from '@jest/globals';
import { EXA_USAGE_TYPE_MAX_LENGTH, type ExaUsageRecord } from '@kilocode/usage-contracts';
import { buildExaUsageRecord, type ExaUsageRecordInput } from './exa-usage-record';

const base: ExaUsageRecordInput = {
  id: '4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f',
  occurredAt: '2026-11-06T12:00:00.000Z',
  userId: 'user-123',
  organizationId: undefined,
  path: '/search',
  costMicrodollars: 7000,
  chargedToBalance: false,
  freeAllowanceMicrodollars: 10_000_000,
  featureId: undefined,
  type: undefined,
};

describe('buildExaUsageRecord', () => {
  it('preserves an ordinary optional type value', () => {
    const record = buildExaUsageRecord({ ...base, type: 'deep' });
    expect(record.type).toBe('deep');
  });

  it('omits a type whose only contents is an embedded NUL', () => {
    const record = buildExaUsageRecord({ ...base, type: '\u0000' });
    expect(record).not.toHaveProperty('type');
  });

  it('omits a type that carries an embedded NUL alongside ordinary text', () => {
    const record = buildExaUsageRecord({ ...base, type: 'deep\u0000tail' });
    expect(record).not.toHaveProperty('type');
  });

  it('still omits a type longer than the contract bound', () => {
    const record = buildExaUsageRecord({
      ...base,
      type: 't'.repeat(EXA_USAGE_TYPE_MAX_LENGTH + 1),
    });
    expect(record).not.toHaveProperty('type');
  });

  it('leaves every required accounting field unchanged', () => {
    const input: ExaUsageRecordInput = { ...base, type: 'deep\u0000tail' };
    const record: ExaUsageRecord = buildExaUsageRecord(input);
    expect(record).toMatchObject({
      id: input.id,
      occurredAt: input.occurredAt,
      userId: input.userId,
      organizationId: null,
      path: input.path,
      costMicrodollars: input.costMicrodollars,
      chargedToBalance: input.chargedToBalance,
      freeAllowanceMicrodollars: input.freeAllowanceMicrodollars,
    });
  });
});
