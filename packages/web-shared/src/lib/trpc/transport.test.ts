import { describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { trpcErrorFormatter } from './transport';

function format(cause: unknown) {
  const error = new TRPCError({
    code: 'FORBIDDEN',
    message: 'Explicit support access is required for this organization',
    cause,
  });
  return trpcErrorFormatter({
    shape: {
      message: error.message,
      code: -32003,
      data: {
        code: 'FORBIDDEN',
        httpStatus: 403,
        path: 'organizations.usageStats',
        stack: undefined,
      },
    },
    error,
  } as never);
}

function shapeFor(error: TRPCError) {
  return {
    message: error.message,
    code: -32603,
    data: {
      code: error.code,
      httpStatus: 403,
      path: 'admin.test',
      stack: '',
    },
  };
}

describe('trpcErrorFormatter support access reason', () => {
  test('surfaces the support access denial reason to the client', () => {
    expect(format({ supportAccessReason: 'support_grant_expired' }).data).toMatchObject({
      supportAccessReason: 'support_grant_expired',
    });
  });

  test.each(['support_grant_required', 'support_grant_revoked'])('passes through %s', reason => {
    expect(format({ supportAccessReason: reason }).data.supportAccessReason).toBe(reason);
  });

  test('omits the field when the cause has no reason', () => {
    expect(format({ unrelated: true }).data).not.toHaveProperty('supportAccessReason');
  });
});

describe('trpcErrorFormatter step-up data', () => {
  test('exposes only the stable step-up contract', () => {
    const error = new TRPCError({
      code: 'FORBIDDEN',
      message: 'MFA is required for this action',
      cause: new StepUpRequiredError({
        code: 'MFA_EXPIRED',
        actionClass: 'platform_read',
        purpose: 'session',
        maxAgeSeconds: 900,
      }),
    });

    const result = trpcErrorFormatter({ shape: shapeFor(error), error } as never);

    expect(result.data.stepUp).toEqual({
      code: 'MFA_EXPIRED',
      actionClass: 'platform_read',
      purpose: 'session',
      maxAgeSeconds: 900,
    });
  });

  test('omits step-up data for an ordinary error', () => {
    const error = new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });

    const result = trpcErrorFormatter({ shape: shapeFor(error), error } as never);

    expect(result.data.stepUp).toBeUndefined();
  });
});
