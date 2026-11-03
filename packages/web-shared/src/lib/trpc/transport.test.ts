import { TRPCError } from '@trpc/server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { trpcErrorFormatter } from './transport';

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

describe('trpcErrorFormatter step-up data', () => {
  it('exposes only the stable step-up contract', () => {
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

  it('omits step-up data for an ordinary error', () => {
    const error = new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });

    const result = trpcErrorFormatter({ shape: shapeFor(error), error } as never);

    expect(result.data.stepUp).toBeUndefined();
  });
});
