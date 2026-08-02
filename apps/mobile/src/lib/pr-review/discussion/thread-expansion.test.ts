import { describe, expect, it } from 'vitest';

import {
  expandedForThread,
  expandThread,
  seedThreadExpansion,
  shouldDeferExpand,
  toggleThreadExpanded,
} from './thread-expansion';

describe('thread-expansion', () => {
  describe('expandedForThread', () => {
    it('defaults unresolved threads to expanded', () => {
      expect(expandedForThread({}, 't1', false)).toBe(true);
    });

    it('defaults resolved threads to collapsed', () => {
      expect(expandedForThread({}, 't1', true)).toBe(false);
    });

    it('prefers an explicit stored value over the resolution default', () => {
      expect(expandedForThread({ t1: true }, 't1', true)).toBe(true);
      expect(expandedForThread({ t1: false }, 't1', false)).toBe(false);
    });
  });

  describe('seedThreadExpansion', () => {
    it('adds missing threads with first-sight defaults', () => {
      const seeded = seedThreadExpansion({}, [
        { threadId: 'a', isResolved: false },
        { threadId: 'b', isResolved: true },
      ]);
      expect(seeded).toEqual({ a: true, b: false });
    });

    it('preserves explicit entries and only fills gaps', () => {
      const state = { a: false };
      const seeded = seedThreadExpansion(state, [
        { threadId: 'a', isResolved: false },
        { threadId: 'b', isResolved: true },
      ]);
      expect(seeded).toEqual({ a: false, b: false });
      expect(seeded).not.toBe(state);
    });

    it('returns the same reference when nothing is new', () => {
      const state = { a: true, b: false };
      const seeded = seedThreadExpansion(state, [
        { threadId: 'a', isResolved: false },
        { threadId: 'b', isResolved: true },
      ]);
      expect(seeded).toBe(state);
    });

    it('does not change a seeded entry when resolution flips (first-sight)', () => {
      let state = seedThreadExpansion({}, [{ threadId: 'a', isResolved: false }]);
      expect(state).toEqual({ a: true });
      // Thread becomes resolved; re-seed must keep the open entry.
      state = seedThreadExpansion(state, [{ threadId: 'a', isResolved: true }]);
      expect(state).toEqual({ a: true });
      expect(expandedForThread(state, 'a', true)).toBe(true);
    });
  });

  describe('toggleThreadExpanded', () => {
    it('flips the effective value and stores it explicitly', () => {
      expect(toggleThreadExpanded({}, 't1', true)).toEqual({ t1: true });
      expect(toggleThreadExpanded({}, 't1', false)).toEqual({ t1: false });
      expect(toggleThreadExpanded({ t1: true }, 't1', true)).toEqual({ t1: false });
    });
  });

  describe('expandThread', () => {
    it('sets the thread expanded', () => {
      expect(expandThread({}, 't1')).toEqual({ t1: true });
      expect(expandThread({ t1: false }, 't1')).toEqual({ t1: true });
    });

    it('returns the same reference when already true', () => {
      const state = { t1: true };
      expect(expandThread(state, 't1')).toBe(state);
    });
  });

  describe('shouldDeferExpand', () => {
    it('defers when layout is unknown (null)', () => {
      expect(shouldDeferExpand(null, 0)).toBe(true);
      expect(shouldDeferExpand(null, 100)).toBe(true);
    });

    it('defers when the row top is scrolled above the viewport', () => {
      expect(shouldDeferExpand(50, 80)).toBe(true);
    });

    it('does not defer when exactly at the top boundary (strict >)', () => {
      expect(shouldDeferExpand(100, 100)).toBe(false);
    });

    it('does not defer when fully visible (scroll below row top)', () => {
      expect(shouldDeferExpand(100, 40)).toBe(false);
    });
  });
});
