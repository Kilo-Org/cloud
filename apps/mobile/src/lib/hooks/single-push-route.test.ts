import { type Href } from 'expo-router';
import { describe, expect, it } from 'vitest';

import {
  claimSinglePush,
  hrefKey,
  SINGLE_PUSH_GUARD_MS,
  type SinglePushGuardState,
} from './single-push-route';

const T0 = 1_700_000_000_000;
const A = '/(app)/security-agent/personal/audit-report';
const B = '/(app)/security-agent/personal/findings';

function freshState(): SinglePushGuardState {
  return { lastPushAt: 0, lastKey: '' };
}

describe('claimSinglePush', () => {
  it('claims the first press and records when it was accepted', () => {
    const state = freshState();

    expect(claimSinglePush(state, T0, A)).toBe(true);
    expect(state.lastPushAt).toBe(T0);
    expect(state.lastKey).toBe(A);
  });

  it('refuses the second press of a double tap without moving the window', () => {
    const state = freshState();
    claimSinglePush(state, T0, A);

    expect(claimSinglePush(state, T0 + 40, A)).toBe(false);
    expect(state.lastPushAt).toBe(T0);
  });

  it('accepts a press at the window boundary and refuses the one before it', () => {
    const state = freshState();
    claimSinglePush(state, T0, A);

    expect(claimSinglePush(state, T0 + SINGLE_PUSH_GUARD_MS - 1, A)).toBe(false);
    expect(claimSinglePush(state, T0 + SINGLE_PUSH_GUARD_MS, A)).toBe(true);
  });

  it('accepts a press right after the screen cleared the guard on focus', () => {
    const state = freshState();
    claimSinglePush(state, T0, A);
    state.lastPushAt = 0;

    expect(claimSinglePush(state, T0 + 40, A)).toBe(true);
  });

  it('accepts a nearby press on a different destination', () => {
    const state = freshState();
    claimSinglePush(state, T0, A);

    expect(claimSinglePush(state, T0 + 40, B)).toBe(true);
    expect(state.lastKey).toBe(B);
  });
});

describe('hrefKey', () => {
  it('gives a route string one stable key', () => {
    expect(hrefKey(A)).toBe(hrefKey(A));
    expect(hrefKey(A)).not.toBe(hrefKey(B));
  });

  it('separates object destinations by pathname and params', () => {
    const filter = (status: string): Href => ({
      pathname: '/(app)/security-agent/[scope]/filter',
      params: { scope: 'personal', status },
    });

    expect(hrefKey(filter('open'))).toBe(hrefKey(filter('open')));
    expect(hrefKey(filter('open'))).not.toBe(hrefKey(filter('dismissed')));
  });
});
