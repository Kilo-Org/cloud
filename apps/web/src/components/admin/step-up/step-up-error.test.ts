import { describe, expect, it } from '@jest/globals';
import type { StepUpOperationBinding } from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  formatStepUpRemaining,
  stepUpDialogDescription,
  stepUpDialogTitle,
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

  const binding = {
    actionClass: 'sensitive_write',
    surface: 'trpc',
    route: 'admin.users.updateStatus',
    method: 'mutation',
    targetKind: 'user',
    targetId: 'user_123',
  } as const satisfies StepUpOperationBinding;

  it('names the route and target of a bound operation', () => {
    const description = stepUpDialogDescription({
      code: 'MFA_REQUIRED',
      actionClass: 'sensitive_write',
      purpose: 'operation',
      binding,
    });
    expect(description).toContain('Confirm it is you with your passkey to continue.');
    expect(description).toContain('admin.users.updateStatus');
    expect(description).toContain('user_123');
  });

  it('keeps the session sentence with no operation text', () => {
    const description = stepUpDialogDescription({
      code: 'MFA_REQUIRED',
      actionClass: 'sensitive_write',
      purpose: 'session',
    });
    expect(description).toBe('Confirm it is you with your passkey to continue.');
    expect(description).not.toContain('admin.users.updateStatus');
  });

  it('names the route alone when the binding has no target', () => {
    const description = stepUpDialogDescription({
      code: 'MFA_EXPIRED',
      actionClass: 'sensitive_write',
      purpose: 'operation',
      binding: { ...binding, targetKind: 'none', targetId: null },
    });
    expect(description).toContain('admin.users.updateStatus');
    expect(description).not.toContain('null');
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
