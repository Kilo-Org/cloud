import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildTimedGreeting } from '@/components/home/greeting';

describe('buildTimedGreeting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('time-of-day buckets', () => {
    test('09:00 → Good morning', () => {
      vi.setSystemTime(new Date('2026-07-31T09:00:00'));
      expect(buildTimedGreeting('Ada')).toBe('Good morning, Ada');
      expect(buildTimedGreeting()).toBe('Good morning');
    });

    test('14:00 → Good afternoon', () => {
      vi.setSystemTime(new Date('2026-07-31T14:00:00'));
      expect(buildTimedGreeting('Ada')).toBe('Good afternoon, Ada');
      expect(buildTimedGreeting()).toBe('Good afternoon');
    });

    test('20:00 → Good evening', () => {
      vi.setSystemTime(new Date('2026-07-31T20:00:00'));
      expect(buildTimedGreeting('Ada')).toBe('Good evening, Ada');
      expect(buildTimedGreeting()).toBe('Good evening');
    });
  });

  describe('name handling at 09:00', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2026-07-31T09:00:00'));
    });

    test('first token only of a multi-word name', () => {
      expect(buildTimedGreeting('Ada Lovelace')).toBe('Good morning, Ada');
    });

    test('single name is used as-is', () => {
      expect(buildTimedGreeting('Ada')).toBe('Good morning, Ada');
    });

    test('no name → "Good morning" with no trailing comma/space', () => {
      expect(buildTimedGreeting()).toBe('Good morning');
      expect(buildTimedGreeting(null)).toBe('Good morning');
      expect(buildTimedGreeting('')).toBe('Good morning');
      expect(buildTimedGreeting('   ')).toBe('Good morning');
    });
  });
});
