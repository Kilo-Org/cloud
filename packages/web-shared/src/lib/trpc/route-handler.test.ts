jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createTRPCContext: jest.fn(async () => ({})),
}));
jest.mock('@kilocode/web-shared/lib/trpc/error-utils', () => ({
  logTRPCError: jest.fn(),
}));

import { describe, expect, it } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { createTRPCRouteHandler } from './route-handler';

function handlerThrowing(error: TRPCError) {
  return createTRPCRouteHandler(() => ({
    run: async () => {
      throw error;
    },
  }));
}

describe('createTRPCRouteHandler step-up mapping', () => {
  it.each(['BEARER_NOT_ALLOWED', 'MFA_REQUIRED', 'STEP_UP_UNAVAILABLE'] as const)(
    'maps %s to a 403 REST code',
    async code => {
      const handle = handlerThrowing(
        new TRPCError({
          code: 'FORBIDDEN',
          message: 'MFA is required for this action',
          cause: new StepUpRequiredError({
            code,
            actionClass: 'platform_read',
            purpose: 'session',
            maxAgeSeconds: 900,
          }),
        })
      );

      const response = await handle(
        new Request('http://localhost/admin/api/test') as never,
        caller => caller.run()
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: code, message: code });
    }
  );

  it('keeps ordinary TRPC errors on their normal status', async () => {
    const handle = handlerThrowing(
      new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' })
    );

    const response = await handle(new Request('http://localhost/admin/api/test') as never, caller =>
      caller.run()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Admin access required',
      message: 'Admin access required',
    });
  });
});
