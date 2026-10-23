import { describe, expect, it } from 'vitest';

import { cloudPrepareFailureMessage } from '@/components/agents/cloud-prepare-error-display';

import '@/i18n';

function makeError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { data: { code } });
  return error;
}

describe('cloudPrepareFailureMessage', () => {
  it('maps the organization access denial message to the organization access copy', () => {
    const denial = makeError('UNAUTHORIZED', 'You do not have access to this organization');
    expect(cloudPrepareFailureMessage(denial)).toBe(
      'Check your access to this organization, then try again.'
    );
  });

  it('maps the shaped server error form too', () => {
    const denial = {
      shape: {
        data: { code: 'UNAUTHORIZED', message: 'You do not have access to this organization' },
      },
    };
    expect(cloudPrepareFailureMessage(denial)).toBe(
      'Check your access to this organization, then try again.'
    );
  });

  it('does not key the organization copy on the code alone', () => {
    // UNAUTHORIZED/FORBIDDEN also carry unrelated failures (trial expiry,
    // model-catalog access, re-authentication), so only the precise denial
    // message maps to the organization copy.
    const trial = makeError('FORBIDDEN', 'Organization trial has expired.');
    const reauth = makeError('UNAUTHORIZED', 'Invalid token');
    expect(cloudPrepareFailureMessage(trial)).toBe(
      'Something went wrong on our end. Please try again.'
    );
    expect(cloudPrepareFailureMessage(reauth)).toBe(
      'Something went wrong on our end. Please try again.'
    );
  });

  it('maps the unavailable-model rejection to the model picker copy', () => {
    const model = makeError(
      'BAD_REQUEST',
      'Selected model is not available for this cloud agent session'
    );
    expect(cloudPrepareFailureMessage(model)).toBe(
      "This model isn't available for Cloud Agent. Choose another model and try again."
    );
  });

  it.each(['integration_mismatch', 'no_installation_found', 'repository_not_installed'] as const)(
    'maps the %s repository refusal to the actionable repository copy',
    reason => {
      // The runtime refuses a repository the selected installation cannot
      // reach before it allocates anything; the copy is the same guidance the
      // branch row gives for the same refusal.
      const refusal = makeError(
        'BAD_REQUEST',
        `GitHub repository authorization failed (${reason})`
      );
      expect(cloudPrepareFailureMessage(refusal)).toBe(
        "Branches aren't available for this repository. Check your access with the provider, then pick another repository."
      );
    }
  );

  it('keeps the generic copy for a credential-service failure worded the same way', () => {
    // The same message prefix also covers a temporarily unavailable credential
    // service, which retrying does fix.
    const service = makeError(
      'SERVICE_UNAVAILABLE',
      'GitHub repository authorization failed (rpc_error)'
    );
    expect(cloudPrepareFailureMessage(service)).toBe(
      'Something went wrong on our end. Please try again.'
    );
  });

  it('maps PAYMENT_REQUIRED to the credits copy', () => {
    expect(cloudPrepareFailureMessage(makeError('PAYMENT_REQUIRED', 'add credits'))).toBe(
      'Not enough credits to run Cloud Agent. Add credits and try again.'
    );
  });

  it('maps a missing profile record to the removed-or-unavailable copy', () => {
    const missing = makeError('NOT_FOUND', "Profile 'profile-42' not found");
    const message = cloudPrepareFailureMessage(missing);
    expect(message).toBe('This item may have been removed or is no longer available.');
    expect(message).not.toContain('profile-42');
  });

  it('maps the shaped form of a missing record too', () => {
    const missing = {
      shape: {
        data: { code: 'NOT_FOUND', message: "Profile 'profile-42' not found" },
      },
    };
    expect(cloudPrepareFailureMessage(missing)).toBe(
      'This item may have been removed or is no longer available.'
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
