import { describe, expect, it } from 'vitest';

import {
  createSuggestionActionLock,
  resolveSuggestionPresentation,
  suggestionActionError,
} from './suggestion-card-state';

describe('resolveSuggestionPresentation', () => {
  const suggestion = { requestId: 'sug-1', callId: 'call-1' };

  it('is interactive only for a pending matching call', () => {
    expect(resolveSuggestionPresentation('pending', 'call-1', suggestion)).toBe('interactive');
    expect(resolveSuggestionPresentation('running', 'call-1', suggestion)).toBe('interactive');
  });

  it.each([
    ['completed', 'call-1'],
    ['error', 'call-1'],
    ['pending', 'other-call'],
    ['pending', undefined],
  ] as const)('is compact for %s / %s', (status, callId) => {
    expect(resolveSuggestionPresentation(status, callId, suggestion)).toBe('compact');
  });
});

describe('createSuggestionActionLock', () => {
  it('rejects duplicate acquisition until released', () => {
    const lock = createSuggestionActionLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
  });
});

it('uses fixed safe error copy', () => {
  expect(suggestionActionError('accept')).toBe("Couldn't apply this suggestion. Try again.");
  expect(suggestionActionError('dismiss')).toBe("Couldn't dismiss this suggestion. Try again.");
});
