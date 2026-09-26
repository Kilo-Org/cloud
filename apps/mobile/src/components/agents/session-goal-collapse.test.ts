import { describe, expect, it } from 'vitest';

import {
  clearSessionGoalCollapseState,
  isSessionGoalCollapsed,
  setSessionGoalCollapsed,
  toggleSessionGoalCollapsed,
} from './session-goal-collapse';

// The store is module-level and shared by every test in this file, so each
// case uses its own session id.
describe('session goal collapse store', () => {
  it('defaults an unknown session to expanded', () => {
    expect(isSessionGoalCollapsed('collapse-session-default')).toBe(false);
  });

  it('reflects a set value and clears it back to expanded', () => {
    setSessionGoalCollapsed('collapse-session-set', true);
    expect(isSessionGoalCollapsed('collapse-session-set')).toBe(true);

    setSessionGoalCollapsed('collapse-session-set', false);
    expect(isSessionGoalCollapsed('collapse-session-set')).toBe(false);
  });

  it('leaves the value unchanged for a no-op set', () => {
    setSessionGoalCollapsed('collapse-session-noop', true);
    setSessionGoalCollapsed('collapse-session-noop', true);
    expect(isSessionGoalCollapsed('collapse-session-noop')).toBe(true);

    setSessionGoalCollapsed('collapse-session-noop', false);
    setSessionGoalCollapsed('collapse-session-noop', false);
    expect(isSessionGoalCollapsed('collapse-session-noop')).toBe(false);
  });

  it('scopes the value to one session id', () => {
    setSessionGoalCollapsed('collapse-session-b', true);
    setSessionGoalCollapsed('collapse-session-c', false);

    expect(isSessionGoalCollapsed('collapse-session-b')).toBe(true);
    expect(isSessionGoalCollapsed('collapse-session-c')).toBe(false);

    setSessionGoalCollapsed('collapse-session-b', false);

    expect(isSessionGoalCollapsed('collapse-session-b')).toBe(false);
    expect(isSessionGoalCollapsed('collapse-session-c')).toBe(false);
  });

  it('flips the value with toggle', () => {
    toggleSessionGoalCollapsed('collapse-session-toggle');
    expect(isSessionGoalCollapsed('collapse-session-toggle')).toBe(true);

    toggleSessionGoalCollapsed('collapse-session-toggle');
    expect(isSessionGoalCollapsed('collapse-session-toggle')).toBe(false);
  });

  // Last case in the file: this one clears the shared module store.
  it('drops every session with the sign-out clear', () => {
    setSessionGoalCollapsed('collapse-session-clear-a', true);
    setSessionGoalCollapsed('collapse-session-clear-b', true);
    expect(isSessionGoalCollapsed('collapse-session-clear-a')).toBe(true);

    clearSessionGoalCollapseState();

    expect(isSessionGoalCollapsed('collapse-session-clear-a')).toBe(false);
    expect(isSessionGoalCollapsed('collapse-session-clear-b')).toBe(false);
  });
});
