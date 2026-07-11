import { describe, expect, it } from 'vitest';

import {
  limitError,
  MAX_DAILY_LIMIT_USD,
  parseLimit,
} from '@/components/organization/member-limit-validators';

describe('limitError', () => {
  it('disables save on a blank field instead of treating it as "remove"', () => {
    expect(limitError('')).not.toBeNull();
    expect(limitError('   ')).not.toBeNull();
  });

  it('accepts an amount within range', () => {
    expect(limitError('10')).toBeNull();
    expect(limitError(String(MAX_DAILY_LIMIT_USD))).toBeNull();
    expect(limitError('0')).toBeNull();
  });

  it('rejects out-of-range or non-numeric input', () => {
    expect(limitError('-1')).not.toBeNull();
    expect(limitError(String(MAX_DAILY_LIMIT_USD + 1))).not.toBeNull();
    expect(limitError('abc')).not.toBeNull();
  });
});

describe('parseLimit', () => {
  it('parses a numeric string', () => {
    expect(parseLimit('42')).toBe(42);
  });

  it('parses blank as null', () => {
    expect(parseLimit('')).toBeNull();
    expect(parseLimit('   ')).toBeNull();
  });
});
