import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { z } from 'zod';

import type { TRPCContext } from '../types.js';
import { internalApiProtectedProcedure, protectedProcedure, publicProcedure, t } from './auth.js';

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

describe('scoped Cloud Agent Worker authorization', () => {
  const authority = {
    version: 1 as const,
    ownerId: 'owner',
    parentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
    organizationId: null,
    procedures: ['cloudAgentNext.prepareSession' as const],
    repositories: ['acme/widgets'],
    models: ['kilo/test-model'],
    remainingDepth: 1 as const,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
  const input = {
    prompt: 'child',
    mode: 'code',
    githubRepo: 'acme/widgets',
    model: 'kilo/test-model',
    autoInitiate: true,
    parentCloudAgentSessionId: authority.parentSessionId,
  };
  const scopedRouter = t.router({
    prepareSession: internalApiProtectedProcedure
      .input(z.unknown())
      .mutation(({ ctx }) => ({ owner: ctx.userId })),
    updateSession: internalApiProtectedProcedure
      .input(z.unknown())
      .mutation(() => ({ forbidden: true })),
    send: protectedProcedure.input(z.unknown()).mutation(() => ({ forbidden: true })),
    health: publicProcedure.query(() => ({ forbidden: true })),
  });
  const context = (internalApiKey?: string): TRPCContext => ({
    env: { INTERNAL_API_SECRET: 'internal-fixture' } as TRPCContext['env'],
    request: new Request('https://worker.test/trpc/prepareSession', {
      headers: internalApiKey ? { 'x-internal-api-key': internalApiKey } : {},
    }),
    userId: authority.ownerId,
    authToken: 'verified-scoped-fixture',
    cloudAgentAuthority: authority,
  });

  it('requires the trusted internal API boundary even for a valid scoped bearer', async () => {
    for (const key of [undefined, 'wrong-key']) {
      await expect(
        scopedRouter.createCaller(context(key)).prepareSession(input)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(
      scopedRouter.createCaller(context('internal-fixture')).prepareSession(input)
    ).resolves.toEqual({ owner: 'owner' });
  });

  it('refuses every other procedure, including public and internal endpoints', async () => {
    const caller = scopedRouter.createCaller(context('internal-fixture'));
    await expect(caller.updateSession(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.send(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.health()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses raw parent/depth/config changes before an input schema can erase them', async () => {
    const caller = scopedRouter.createCaller(context('internal-fixture'));
    for (const change of [
      { parentCloudAgentSessionId: 'workspace_other' },
      { cloudAgentSpawn: {} },
      { remainingDepth: 2 },
      { mcpServers: {} },
      { profileId: 'profile' },
      { model: 'kilo/other' },
      { githubRepo: 'acme/other' },
    ]) {
      await expect(caller.prepareSession({ ...input, ...change })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  });
});
