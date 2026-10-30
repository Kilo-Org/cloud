import { describe, expect, it } from 'vitest';

import {
  claimHeaderBack,
  HEADER_BACK_GUARD_MS,
  type HeaderBackGuardState,
  resolveHeaderBack,
} from './header-back';

const T0 = 1_700_000_000_000;

function freshState(): HeaderBackGuardState {
  return { lastBackAt: 0 };
}

describe('claimHeaderBack', () => {
  it('claims the first press and records when it was accepted', () => {
    const state = freshState();

    expect(claimHeaderBack(state, T0)).toBe(true);
    expect(state.lastBackAt).toBe(T0);
  });

  it('drops a repeat inside the window so one burst dispatches one back', () => {
    const state = freshState();
    claimHeaderBack(state, T0);

    expect(claimHeaderBack(state, T0 + 4)).toBe(false);
    expect(claimHeaderBack(state, T0 + 40)).toBe(false);
    expect(state.lastBackAt).toBe(T0);
  });

  it('accepts the press at the end of the window', () => {
    const state = freshState();
    claimHeaderBack(state, T0);

    expect(claimHeaderBack(state, T0 + HEADER_BACK_GUARD_MS - 1)).toBe(false);
    expect(claimHeaderBack(state, T0 + HEADER_BACK_GUARD_MS)).toBe(true);
  });
});

describe('resolveHeaderBack', () => {
  it('runs the screen handler before anything else', () => {
    expect(resolveHeaderBack({ hasHandler: true, hasFallback: false, canGoBack: false })).toBe(
      'handler'
    );
    expect(resolveHeaderBack({ hasHandler: true, hasFallback: true, canGoBack: true })).toBe(
      'handler'
    );
  });

  it('pops the navigator when it has history', () => {
    expect(resolveHeaderBack({ hasHandler: false, hasFallback: false, canGoBack: true })).toBe(
      'history'
    );
    expect(resolveHeaderBack({ hasHandler: false, hasFallback: true, canGoBack: true })).toBe(
      'history'
    );
  });

  it('uses the declared fallback when there is no history', () => {
    expect(resolveHeaderBack({ hasHandler: false, hasFallback: true, canGoBack: false })).toBe(
      'fallback'
    );
  });

  it('does nothing when there is neither history nor a fallback', () => {
    expect(resolveHeaderBack({ hasHandler: false, hasFallback: false, canGoBack: false })).toBe(
      'none'
    );
  });
});
