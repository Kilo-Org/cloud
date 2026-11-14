jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createTRPCContext: jest.fn(async () => ({})),
}));
jest.mock('@kilocode/web-shared/lib/trpc/error-utils', () => ({
  logTRPCError: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { clientName: 'primary' },
  readDb: { clientName: 'replica' },
}));

import { describe, expect, it } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import type * as Drizzle from '@kilocode/web-shared/lib/drizzle';
import { createTRPCRouteHandler } from './route-handler';

function handlerThrowing(error: TRPCError) {
  return createTRPCRouteHandler(() => ({
    run: async () => {
      throw error;
    },
  }));
}

describe('createTRPCRouteHandler context options', () => {
  function echoContextOptions() {
    const { createTRPCContext } = jest.requireMock<{
      createTRPCContext: jest.Mock;
    }>('@kilocode/web-shared/lib/trpc/init');
    createTRPCContext.mockImplementation(async (opts?: { fromDb?: unknown }) => ({
      fromDb: opts?.fromDb,
    }));
    return createTRPCContext;
  }

  it('passes the configured read client into the request context', async () => {
    const createTRPCContext = echoContextOptions();
    const { readDb } = jest.requireMock<typeof Drizzle>('@kilocode/web-shared/lib/drizzle');
    const handle = createTRPCRouteHandler(
      (ctx: { fromDb?: unknown }) => ({
        run: async () => ({ readsReplica: ctx.fromDb === readDb }),
      }),
      { fromDb: readDb }
    );

    const response = await handle(
      new Request('http://localhost/api/v1/organizations/org-1/models') as never,
      caller => caller.run()
    );

    expect(createTRPCContext).toHaveBeenCalledWith({
      req: expect.anything(),
      fromDb: readDb,
    });
    await expect(response.json()).resolves.toEqual({ readsReplica: true });
  });

  it('leaves the client unset when the route handler configures none', async () => {
    const createTRPCContext = echoContextOptions();
    const handle = createTRPCRouteHandler((ctx: { fromDb?: unknown }) => ({
      run: async () => ({ readsReplica: ctx.fromDb !== undefined }),
    }));

    const response = await handle(new Request('http://localhost/api/test') as never, caller =>
      caller.run()
    );

    expect(createTRPCContext).toHaveBeenCalledWith({
      req: expect.anything(),
      fromDb: undefined,
    });
    await expect(response.json()).resolves.toEqual({ readsReplica: false });
  });
});

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
