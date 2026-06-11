import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import type { TRPCContext } from '../types.js';
import { t } from './auth.js';

const testRouter = t.router({
  invalid: t.procedure.query(() => {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid request' });
  }),
  unavailable: t.procedure.query(() => {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Sandbox unavailable',
      cause: { error: 'SANDBOX_CONNECT_FAILED', retryable: true },
    });
  }),
  internal: t.procedure.query(() => {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal failure' });
  }),
});

async function requestProcedure(procedure: 'invalid' | 'unavailable' | 'internal') {
  return fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://localhost/trpc/${procedure}`),
    router: testRouter,
    createContext: () => ({}) as TRPCContext,
  });
}

describe('tRPC client error formatter', () => {
  it('adds a non-retryable client error to known request failures', async () => {
    const response = await requestProcedure('invalid');

    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: 'Invalid request',
        data: {
          code: 'BAD_REQUEST',
          httpStatus: 400,
          path: 'invalid',
          clientError: {
            code: 'BAD_REQUEST',
            message: 'Invalid request',
            retryable: false,
          },
        },
      },
    });
  });

  it('preserves explicit legacy retry fields beside the client error', async () => {
    const response = await requestProcedure('unavailable');

    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: 'Sandbox unavailable',
        data: {
          code: 'SERVICE_UNAVAILABLE',
          httpStatus: 503,
          path: 'unavailable',
          error: 'SANDBOX_CONNECT_FAILED',
          retryable: true,
          clientError: {
            code: 'SANDBOX_CONNECT_FAILED',
            message: 'Sandbox unavailable',
            retryable: true,
          },
        },
      },
    });
  });

  it('defaults generic internal failures to retryable', async () => {
    const response = await requestProcedure('internal');

    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: 'Internal failure',
        data: {
          code: 'INTERNAL_SERVER_ERROR',
          httpStatus: 500,
          path: 'internal',
          clientError: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Internal failure',
            retryable: true,
          },
        },
      },
    });
  });
});
