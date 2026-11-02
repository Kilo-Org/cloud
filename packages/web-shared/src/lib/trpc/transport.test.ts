import { describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
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

describe('trpcErrorFormatter support access reason', () => {
  test('surfaces the enforce-mode denial reason to the client', () => {
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
