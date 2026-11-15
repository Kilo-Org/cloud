import { describe, expect, it } from 'vitest';
import { isControlPlaneFailureReason, messageFailureText } from './failure-messages.js';

describe('messageFailureText', () => {
  it('shows the specific recovery message for unconfirmed completion', () => {
    expect(isControlPlaneFailureReason('completion_unconfirmed')).toBe(true);
    expect(messageFailureText('completion_unconfirmed')).toBe(
      'The assistant finished its reply, but session completion could not be confirmed. Send a new message to continue.'
    );
  });

  it('keeps the missing-outcome message distinct', () => {
    expect(messageFailureText('no_outcome')).toBe('The turn did not complete');
  });

  it('passes through wrapper or Kilo user messages', () => {
    expect(messageFailureText('A specific failure')).toBe('A specific failure');
  });
});
