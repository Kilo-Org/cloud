import { describe, expect, it } from '@jest/globals';
import {
  formatStepUpRemaining,
  stepUpDialogDescription,
  stepUpDialogTitle,
  stepUpRequirementFromError,
  stepUpRequirementFromResponse,
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

  it('reads the operation an operation proof is bound to', () => {
    const operation = { id: 'trpc.admin.users', targetKind: 'user', targetId: 'user-1' };

    expect(
      stepUpRequirementFromError({
        data: {
          stepUp: {
            code: 'MFA_REQUIRED',
            actionClass: 'sensitive_write',
            purpose: 'operation',
            maxAgeSeconds: 300,
            operation,
          },
        },
      })
    ).toEqual({
      code: 'MFA_REQUIRED',
      actionClass: 'sensitive_write',
      purpose: 'operation',
      maxAgeSeconds: 300,
      operation,
    });
  });

  it('rejects a refusal whose operation descriptor is malformed', () => {
    expect(
      stepUpRequirementFromError({
        data: {
          stepUp: {
            code: 'MFA_REQUIRED',
            actionClass: 'sensitive_write',
            purpose: 'operation',
            operation: { id: 7, targetKind: 'user' },
          },
        },
      })
    ).toBeNull();
  });
});

describe('stepUpRequirementFromResponse', () => {
  it('reads the stepUp field of a REST refusal', async () => {
    const operation = { id: 'rest.admin.users', targetKind: 'user', targetId: null };
    const response = new Response(
      JSON.stringify({
        success: false,
        error: 'MFA_REQUIRED',
        stepUp: {
          code: 'MFA_REQUIRED',
          actionClass: 'sensitive_write',
          purpose: 'operation',
          maxAgeSeconds: 300,
          operation,
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    );

    expect(await stepUpRequirementFromResponse(response)).toEqual({
      code: 'MFA_REQUIRED',
      actionClass: 'sensitive_write',
      purpose: 'operation',
      maxAgeSeconds: 300,
      operation,
    });
  });

  it('falls back to the bare error code of an older refusal', async () => {
    const response = new Response(JSON.stringify({ success: false, error: 'MFA_EXPIRED' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

    expect(await stepUpRequirementFromResponse(response)).toEqual({ code: 'MFA_EXPIRED' });
  });
});

describe('step-up dialog copy', () => {
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
