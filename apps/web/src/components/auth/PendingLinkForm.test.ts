import { describe, expect, test } from '@jest/globals';
import { pendingLinkErrorMessage } from './PendingLinkForm';

describe('pendingLinkErrorMessage', () => {
  test.each([
    'SESSION_REQUIRED',
    'WRONG_ACCOUNT',
    'LINKING-FAILED',
    'ACCOUNT-ALREADY-LINKED',
    'PROVIDER-ALREADY-LINKED',
    'EXPIRED',
    'CODE_NOT_REQUESTED',
    'CODE_IN_PROGRESS',
    'INVALID_CODE',
    'TOO_MANY_ATTEMPTS',
    'TOO_MANY_CODES',
    'RATE_LIMITED',
    'EMAIL_CODE_NOT_ALLOWED',
    'EMAIL_DELIVERY_FAILED',
    'BLOCKED',
    'INVALID_ORIGIN',
  ])('renders a distinct message for %s', code => {
    const message = pendingLinkErrorMessage(code);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toBe(pendingLinkErrorMessage('SOMETHING-UNKNOWN'));
  });

  test('falls back to a generic retryable message for unknown codes', () => {
    expect(pendingLinkErrorMessage('SOMETHING-UNKNOWN')).toContain('Try again');
  });
});
