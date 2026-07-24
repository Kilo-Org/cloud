import { describe, expect, it } from 'vitest';

import {
  armInitialTopScroll,
  INITIAL_TOP_SCROLL_IDLE,
  type InitialTopScrollState,
  onInitialTopScrollContentSize,
} from './initial-top-scroll';

describe('initial-top-scroll', () => {
  describe('armInitialTopScroll', () => {
    it('stays idle while files are empty', () => {
      expect(armInitialTopScroll(INITIAL_TOP_SCROLL_IDLE, 0)).toEqual({ status: 'idle' });
    });

    it('arms on the first positive files length', () => {
      expect(armInitialTopScroll(INITIAL_TOP_SCROLL_IDLE, 1)).toEqual({ status: 'armed' });
    });

    it('does not re-arm once armed', () => {
      const armed: InitialTopScrollState = { status: 'armed' };
      expect(armInitialTopScroll(armed, 50)).toBe(armed);
    });

    it('does not re-arm once done (page appends)', () => {
      const done: InitialTopScrollState = { status: 'done' };
      expect(armInitialTopScroll(done, 214)).toBe(done);
    });
  });

  describe('onInitialTopScrollContentSize', () => {
    it('does not scroll while idle (skeleton layout)', () => {
      expect(onInitialTopScrollContentSize(INITIAL_TOP_SCROLL_IDLE, 400)).toEqual({
        state: INITIAL_TOP_SCROLL_IDLE,
        shouldScroll: false,
      });
    });

    it('waits for positive content height while armed', () => {
      const armed: InitialTopScrollState = { status: 'armed' };
      expect(onInitialTopScrollContentSize(armed, 0)).toEqual({
        state: armed,
        shouldScroll: false,
      });
    });

    it('fires once when armed content has positive height', () => {
      expect(onInitialTopScrollContentSize({ status: 'armed' }, 320)).toEqual({
        state: { status: 'done' },
        shouldScroll: true,
      });
    });

    it('never scrolls again after done', () => {
      const done: InitialTopScrollState = { status: 'done' };
      expect(onInitialTopScrollContentSize(done, 800)).toEqual({
        state: done,
        shouldScroll: false,
      });
    });
  });

  describe('cold and warm sequences', () => {
    it('cold: skeleton size then files arm then layout fires once', () => {
      let state = INITIAL_TOP_SCROLL_IDLE;

      // Skeleton content-size while still loading.
      let result = onInitialTopScrollContentSize(state, 200);
      expect(result.shouldScroll).toBe(false);
      state = result.state;

      // First page arrives.
      state = armInitialTopScroll(state, 50);
      expect(state).toEqual({ status: 'armed' });

      // Real content lays out.
      result = onInitialTopScrollContentSize(state, 1200);
      expect(result).toEqual({ state: { status: 'done' }, shouldScroll: true });
      state = result.state;

      // Page appends must not re-scroll.
      state = armInitialTopScroll(state, 100);
      result = onInitialTopScrollContentSize(state, 2400);
      expect(result.shouldScroll).toBe(false);
      expect(state.status).toBe('done');
    });

    it('warm-cache: arm on first render then first layout fires once', () => {
      const state = armInitialTopScroll(INITIAL_TOP_SCROLL_IDLE, 214);
      expect(state).toEqual({ status: 'armed' });

      const result = onInitialTopScrollContentSize(state, 5000);
      expect(result).toEqual({ state: { status: 'done' }, shouldScroll: true });
    });
  });
});
