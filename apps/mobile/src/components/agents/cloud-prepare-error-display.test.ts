import { describe, expect, it } from 'vitest';

import { cloudPrepareFailureMessage } from '@/components/agents/cloud-prepare-error-display';

import '@/i18n';

function makeError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { data: { code } });
  return error;
}

describe('cloudPrepareFailureMessage', () => {
  it('maps an organization access denial to the organization access copy', () => {
    const denial = makeError('UNAUTHORIZED', 'You do not have access to this organization');
    expect(cloudPrepareFailureMessage(denial)).toBe(
      'Check your access to this organization, then try again.'
    );
  });

  it('maps FORBIDDEN to the organization access copy', () => {
    expect(cloudPrepareFailureMessage(makeError('FORBIDDEN', 'nope'))).toBe(
      'Check your access to this organization, then try again.'
    );
  });

  it('reads the shaped server error form too', () => {
    const denial = { shape: { data: { code: 'UNAUTHORIZED', message: 'denied' } } };
    expect(cloudPrepareFailureMessage(denial)).toBe(
      'Check your access to this organization, then try again.'
    );
  });

  it('maps PAYMENT_REQUIRED to the credits copy', () => {
    expect(cloudPrepareFailureMessage(makeError('PAYMENT_REQUIRED', 'add credits'))).toBe(
      'Not enough credits to run Cloud Agent. Add credits and try again.'
    );
  });

  it('never shows the raw server detail for an unclassified rejection', () => {
    const raw = makeError('BAD_REQUEST', 'Runtime credential proxy configuration is unavailable');
    const message = cloudPrepareFailureMessage(raw);
    expect(message).toBe('Something went wrong on our end. Please try again.');
    expect(message).not.toContain('Runtime credential proxy');
  });

  it('uses the generic copy for a plain transport error and a non-error', () => {
    expect(cloudPrepareFailureMessage(new Error('Network request failed'))).toBe(
      'Something went wrong on our end. Please try again.'
    );
    expect(cloudPrepareFailureMessage(null)).toBe(
      'Something went wrong on our end. Please try again.'
    );
  });
});
