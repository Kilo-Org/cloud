import { describe, expect, it } from 'vitest';

import {
  claimSinglePush,
  CODE_REVIEWER_PUSH_GUARD_MS,
  type SinglePushGuardState,
} from './single-push-route';

const T0 = 1_700_000_000_000;

describe('claimSinglePush', () => {
  it('claims the first press and records when it was accepted', () => {
    const state: SinglePushGuardState = { lastPushAt: 0 };

    expect(claimSinglePush(state, T0)).toBe(true);
    expect(state.lastPushAt).toBe(T0);
  });

  it('refuses the second press of a double tap without moving the window', () => {
    const state: SinglePushGuardState = { lastPushAt: 0 };
    claimSinglePush(state, T0);

    expect(claimSinglePush(state, T0 + 40)).toBe(false);
    expect(state.lastPushAt).toBe(T0);
  });

  it('accepts a press at the window boundary and refuses the one before it', () => {
    const state: SinglePushGuardState = { lastPushAt: 0 };
    claimSinglePush(state, T0);

    expect(claimSinglePush(state, T0 + CODE_REVIEWER_PUSH_GUARD_MS - 1)).toBe(false);
    expect(claimSinglePush(state, T0 + CODE_REVIEWER_PUSH_GUARD_MS)).toBe(true);
  });

  it('accepts a press right after the screen cleared the guard on focus', () => {
    const state: SinglePushGuardState = { lastPushAt: 0 };
    claimSinglePush(state, T0);
    state.lastPushAt = 0;

    expect(claimSinglePush(state, T0 + 40)).toBe(true);
  });
});
