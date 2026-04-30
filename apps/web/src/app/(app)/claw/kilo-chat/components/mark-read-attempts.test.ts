import {
  rememberMarkReadAttempt,
  releaseFailedMarkReadAttempt,
  shouldAttemptMarkRead,
} from './mark-read-attempts';

describe('mark-read attempt tracking', () => {
  it('allows retrying the same conversation after a failed mark-read attempt', () => {
    const lastMarkedRef = { current: null };

    expect(shouldAttemptMarkRead(lastMarkedRef.current, 'conversation-1')).toBe(true);
    rememberMarkReadAttempt(lastMarkedRef, 'conversation-1');
    expect(shouldAttemptMarkRead(lastMarkedRef.current, 'conversation-1')).toBe(false);

    releaseFailedMarkReadAttempt(lastMarkedRef, 'conversation-1');

    expect(shouldAttemptMarkRead(lastMarkedRef.current, 'conversation-1')).toBe(true);
  });
});
