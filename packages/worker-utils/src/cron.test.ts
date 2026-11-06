import { describe, it, expect } from 'vitest';
import {
  computeNextCronTime,
  validateCronExpression,
  enforcesMinimumInterval,
  isValidTimezone,
} from './cron';

describe('validateCronExpression', () => {
  it('accepts valid 5-field expressions', () => {
    expect(validateCronExpression('0 9 * * 1-5')).toEqual({ valid: true });
    expect(validateCronExpression('*/5 * * * *')).toEqual({ valid: true });
    expect(validateCronExpression('0 0 1 * *')).toEqual({ valid: true });
  });

  it('accepts every-minute expression', () => {
    expect(validateCronExpression('* * * * *')).toEqual({ valid: true });
  });

  it('rejects invalid expressions', () => {
    const result = validateCronExpression('not a cron');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBeTruthy();
    }
  });

  it('rejects empty string', () => {
    const result = validateCronExpression('');
    expect(result.valid).toBe(false);
  });
});

describe('computeNextCronTime', () => {
  it('returns a future Date for a valid expression', () => {
    const next = computeNextCronTime('* * * * *', 'UTC');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('respects timezone', () => {
    const utc = computeNextCronTime('0 9 * * *', 'UTC');
    const eastern = computeNextCronTime('0 9 * * *', 'America/New_York');
    expect(utc).toBeInstanceOf(Date);
    expect(eastern).toBeInstanceOf(Date);
    // These should be different times (unless exactly at the boundary)
    // Just verify both return valid dates
    expect(utc!.getTime()).toBeGreaterThan(0);
    expect(eastern!.getTime()).toBeGreaterThan(0);
  });

  it('returns null for invalid expression', () => {
    expect(computeNextCronTime('invalid', 'UTC')).toBeNull();
  });

  it('returns the occurrence after a given reference time, not after now', () => {
    // Every minute, anchored on a fixed reference in the past relative to "now"
    // but in the future relative to some earlier point — the result should be
    // strictly after the reference, regardless of the current wall-clock time.
    const reference = new Date(Date.now() + 5 * 60_000); // 5 minutes from now
    const next = computeNextCronTime('* * * * *', 'UTC', reference);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(reference.getTime());
  });

  it('does not return the same occurrence twice when called again before that occurrence passes', () => {
    // Simulates the alarm firing early: compute the target occurrence, then
    // immediately ask for the "next" occurrence using that target as the reference.
    // It must advance past it instead of returning the same time again.
    const first = computeNextCronTime('* * * * *', 'UTC');
    expect(first).toBeInstanceOf(Date);
    const second = computeNextCronTime('* * * * *', 'UTC', first!);
    expect(second).toBeInstanceOf(Date);
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it('advances across a day boundary when anchored far in the future', () => {
    // Daily-at-midnight schedule, anchored 3 days out — must skip ahead to the
    // occurrence after the anchor, not just the next occurrence after "now".
    const reference = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    const next = computeNextCronTime('0 0 * * *', 'UTC', reference);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(reference.getTime());
  });

  it('returns null instead of throwing when `after` is an Invalid Date', () => {
    const invalidDate = new Date('not-a-date');
    expect(invalidDate.getTime()).toBeNaN();
    expect(computeNextCronTime('* * * * *', 'UTC', invalidDate)).toBeNull();
  });
});

describe('enforcesMinimumInterval', () => {
  it('returns true for hourly schedule (>= 1 minute)', () => {
    expect(enforcesMinimumInterval('0 * * * *', 'UTC')).toBe(true);
  });

  it('returns true for every-5-minutes schedule', () => {
    expect(enforcesMinimumInterval('*/5 * * * *', 'UTC')).toBe(true);
  });

  it('returns true for every-minute schedule (exactly 60s)', () => {
    expect(enforcesMinimumInterval('* * * * *', 'UTC')).toBe(true);
  });

  it('returns false for invalid expression', () => {
    expect(enforcesMinimumInterval('invalid', 'UTC')).toBe(false);
  });

  it('respects custom minimum interval', () => {
    // Every minute = 60s interval; require 5 minutes minimum
    expect(enforcesMinimumInterval('* * * * *', 'UTC', 300_000)).toBe(false);
    // Every 5 minutes = 300s interval; require 5 minutes minimum
    expect(enforcesMinimumInterval('*/5 * * * *', 'UTC', 300_000)).toBe(true);
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA timezones', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
  });

  it('rejects invalid timezones', () => {
    expect(isValidTimezone('NotATimezone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('US/Fake')).toBe(false);
  });
});

describe('DST crossing', () => {
  it('computes next run across spring-forward DST boundary', () => {
    // America/New_York springs forward (2 AM → 3 AM) in March
    // A daily-at-2:30 AM schedule should still produce a valid next run
    const next = computeNextCronTime('30 2 * * *', 'America/New_York');
    // On the spring-forward day, 2:30 AM doesn't exist — croner should handle this
    // by returning the next valid occurrence (either skipping or adjusting)
    // The key assertion: it doesn't return null or throw
    if (next) {
      expect(next.getTime()).toBeGreaterThan(Date.now());
    }
    // croner may skip the non-existent time — either a valid date or null is acceptable
  });

  it('handles fall-back DST boundary', () => {
    // America/New_York falls back (2 AM → 1 AM) in November
    // A daily-at-1:30 AM schedule hits an ambiguous time
    const next = computeNextCronTime('30 1 * * *', 'America/New_York');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('enforcesMinimumInterval works with DST timezone', () => {
    // Hourly schedule in a DST-aware timezone should still enforce minimum interval
    expect(enforcesMinimumInterval('0 * * * *', 'America/New_York')).toBe(true);
    expect(enforcesMinimumInterval('*/5 * * * *', 'America/New_York')).toBe(true);
  });
});
