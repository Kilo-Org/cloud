import { describe, expect, it } from '@jest/globals';
import {
  formatStepUpRemaining,
  stepUpDialogDescription,
  stepUpDialogTitle,
  stepUpEnrollmentMessage,
  stepUpRequirementFromError,
} from './step-up-error';

describe('stepUpRequirementFromError', () => {
  it('reads the formatter contract', () => {
    expect(
      stepUpRequirementFromError({
        data: {
          stepUp: {
            code: 'MFA_EXPIRED',
            actionClass: 'sensitive_write',
            purpose: 'operation',
            maxAgeSeconds: 300,
          },
        },
      })
    ).toEqual({
      code: 'MFA_EXPIRED',
      actionClass: 'sensitive_write',
      purpose: 'operation',
      maxAgeSeconds: 300,
    });
  });

  it.each([
    ['a non-object', 'error'],
    ['no data', {}],
    ['no stepUp field', { data: { code: 'FORBIDDEN' } }],
    ['an unknown code', { data: { stepUp: { code: 'SOMETHING_ELSE' } } }],
    ['a missing code', { data: { stepUp: { actionClass: 'platform_read' } } }],
  ])('ignores %s', (_label, error) => {
    expect(stepUpRequirementFromError(error)).toBeNull();
  });
});

describe('step-up dialog copy', () => {
  it('uses one enrollment message for the profile card and the dialog', () => {
    expect(stepUpEnrollmentMessage('REAUTH_REQUIRED')).toBe(
      'Sign in again before adding a passkey. Signing out signs you out of every browser.'
    );
    expect(stepUpDialogDescription({ code: 'REAUTH_REQUIRED' })).toBe(
      stepUpEnrollmentMessage('REAUTH_REQUIRED')
    );
  });

  it('names the action for every refusal', () => {
    for (const code of [
      'MFA_REQUIRED',
      'MFA_EXPIRED',
      'NOT_ENROLLED',
      'SESSION_UNBOUND',
      'BEARER_NOT_ALLOWED',
      'REAUTH_REQUIRED',
      'STEP_UP_UNAVAILABLE',
    ] as const) {
      expect(stepUpDialogTitle({ code })).not.toHaveLength(0);
      expect(stepUpDialogDescription({ code })).not.toHaveLength(0);
    }
  });
});

describe('formatStepUpRemaining', () => {
  const now = new Date('2026-01-01T12:00:00.000Z').getTime();

  it.each([
    ['2026-01-01T12:14:30.000Z', '14 min left'],
    ['2026-01-01T12:00:30.000Z', 'less than a minute left'],
    ['2026-01-01T11:59:00.000Z', 'expired'],
  ])('formats %s as %s', (expiresAt, expected) => {
    expect(formatStepUpRemaining(expiresAt, now)).toBe(expected);
  });
});
