import { describe, expect, it } from 'vitest';

import {
  emailsError,
  parseEmails,
  parseThreshold,
  thresholdError,
} from '@/components/organization/low-balance-alert-validators';

describe('parseThreshold', () => {
  it('parses a positive number', () => {
    expect(parseThreshold('10')).toBe(10);
  });

  it('rejects blank, zero, negative, and non-numeric input', () => {
    expect(parseThreshold('')).toBeNull();
    expect(parseThreshold('0')).toBeNull();
    expect(parseThreshold('-5')).toBeNull();
    expect(parseThreshold('abc')).toBeNull();
  });
});

describe('thresholdError', () => {
  it('returns null for a valid amount', () => {
    expect(thresholdError('10')).toBeNull();
  });

  it('returns an error message for an invalid amount', () => {
    expect(thresholdError('')).not.toBeNull();
    expect(thresholdError('0')).not.toBeNull();
  });
});

describe('parseEmails', () => {
  it('splits, trims, and drops empty entries', () => {
    expect(parseEmails('a@x.com, b@x.com ,, ')).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('emailsError', () => {
  it('returns null when every email is valid', () => {
    expect(emailsError('a@x.com, b@x.com')).toBeNull();
  });

  it('returns an error when the list is empty', () => {
    expect(emailsError('')).not.toBeNull();
    expect(emailsError('  ,  ')).not.toBeNull();
  });

  it('returns an error when any email is malformed', () => {
    expect(emailsError('a@x.com, not-an-email')).not.toBeNull();
  });
});
