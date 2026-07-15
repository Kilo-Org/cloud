import { jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type * as LocalRuntimeControlClientModule from '@/lib/local-runtime-control/client';
import { UpstreamApiError } from '@/lib/trpc/init';
import type * as TestUtilsModule from '@/routers/test-utils';
import type * as RootRouterModule from '@/routers/root-router';
import type * as UserHelperModule from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import type { LocalRuntimeControlErrorCode } from '@kilocode/session-ingest-contracts';

jest.mock('@/lib/local-runtime-control/client', () => {
  const { LocalRuntimeControlRequestError, LocalRuntimeCatalogError } = jest.requireActual<
    typeof LocalRuntimeControlClientModule
  >('@/lib/local-runtime-control/client');
  return {
    LocalRuntimeControlRequestError,
    LocalRuntimeCatalogError,
    LocalRuntimeControlClient: {
      list: jest.fn(),
      getCatalog: jest.fn(),
    },
  };
});

const mockedList = jest.mocked(
  jest.requireMock<typeof LocalRuntimeControlClientModule>('@/lib/local-runtime-control/client')
    .LocalRuntimeControlClient.list
);

const mockedGetCatalog = jest.mocked(
  jest.requireMock<typeof LocalRuntimeControlClientModule>('@/lib/local-runtime-control/client')
    .LocalRuntimeControlClient.getCatalog
);

const { LocalRuntimeControlRequestError, LocalRuntimeCatalogError } = jest.requireActual<
  typeof LocalRuntimeControlClientModule
>('@/lib/local-runtime-control/client');

describe('localRuntimeControl router', () => {
  let user: User;
  let createCallerForUser: typeof TestUtilsModule.createCallerForUser;
  let rootRouter: typeof RootRouterModule.rootRouter;
  let insertTestUser: typeof UserHelperModule.insertTestUser;

  beforeAll(async () => {
    const testUtils = await import('@/routers/test-utils');
    createCallerForUser = testUtils.createCallerForUser;

    const rootRouterMod = await import('@/routers/root-router');
    rootRouter = rootRouterMod.rootRouter;

    const userHelper = await import('@/tests/helpers/user.helper');
    insertTestUser = userHelper.insertTestUser;

    user = await insertTestUser({
      google_user_email: 'local-runtime-control@example.com',
      google_user_name: 'Local Runtime Control',
    });
  });

  beforeEach(() => {
    mockedList.mockReset();
    mockedGetCatalog.mockReset();
  });

  it('is registered on the root router under localRuntimeControl.list', () => {
    expect(Object.keys(rootRouter._def.procedures)).toContain('localRuntimeControl.list');
  });

  it('returns the empty runtime list when the client returns an empty list', async () => {
    mockedList.mockResolvedValueOnce({ runtimes: [] });

    const caller = await createCallerForUser(user.id);
    const result = await caller.localRuntimeControl.list();

    expect(result).toEqual({ runtimes: [] });
    expect(mockedList).toHaveBeenCalledWith(user.id);
  });

  it('returns all first-class runtimes including capability-missing entries', async () => {
    mockedList.mockResolvedValueOnce({
      runtimes: [
        {
          runtimeId: '0c0a1b2c-3d4e-4f60-8a8b-9c0d1e2f3a4b',
          connectionId: 'cli-1',
          protocolVersion: 1,
          cliVersion: '7.4.7',
          displayName: 'Alice Mac',
          projectName: 'customer-repo',
          capabilities: ['catalog.v1', 'create-and-run.v1'],
        },
        {
          runtimeId: '1c0a1b2c-3d4e-4f60-8a8b-9c0d1e2f3a4b',
          connectionId: 'cli-2',
          protocolVersion: 1,
          cliVersion: '7.4.7',
          displayName: 'Bob Mac',
          projectName: 'empty-repo',
          capabilities: ['catalog.v1'],
        },
      ],
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.localRuntimeControl.list();

    expect(result.runtimes).toHaveLength(2);
    expect(result.runtimes[1]?.capabilities).toEqual(['catalog.v1']);
  });

  it('maps a client request error to a BAD_GATEWAY tRPC error', async () => {
    mockedList.mockRejectedValueOnce(
      new LocalRuntimeControlRequestError('Local runtime list request failed (503)')
    );

    const caller = await createCallerForUser(user.id);
    await expect(caller.localRuntimeControl.list()).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
    });
  });

  it('is registered on the root router under localRuntimeControl.getCatalog', () => {
    expect(Object.keys(rootRouter._def.procedures)).toContain('localRuntimeControl.getCatalog');
  });

  describe('localRuntimeControl.getCatalog', () => {
    const validFence = {
      runtimeId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      connectionId: 'cli-77',
    };

    const validCatalogResponse = {
      catalog: {
        protocolVersion: 1 as const,
        models: {
          protocolVersion: 1 as const,
          providers: [],
          truncated: false,
        },
        agents: [{ slug: 'build', name: 'Build' }],
        defaultAgent: 'build',
      },
    };

    it('rejects an invalid runtimeId', async () => {
      const caller = await createCallerForUser(user.id);
      await expect(
        caller.localRuntimeControl.getCatalog({ runtimeId: 'not-a-uuid', connectionId: 'cli-1' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects a missing connectionId', async () => {
      const caller = await createCallerForUser(user.id);
      await expect(
        caller.localRuntimeControl.getCatalog({ runtimeId: validFence.runtimeId } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects extra fields in the input', async () => {
      const caller = await createCallerForUser(user.id);
      await expect(
        caller.localRuntimeControl.getCatalog({ ...validFence, extra: 'field' } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('returns the catalog including capability-missing agent shapes', async () => {
      mockedGetCatalog.mockResolvedValueOnce(validCatalogResponse);

      const caller = await createCallerForUser(user.id);
      const result = await caller.localRuntimeControl.getCatalog(validFence);

      expect(result).toEqual(validCatalogResponse.catalog);
    });

    it('calls the client with the user id and exact fence', async () => {
      mockedGetCatalog.mockResolvedValueOnce(validCatalogResponse);

      const caller = await createCallerForUser(user.id);
      await caller.localRuntimeControl.getCatalog(validFence);

      expect(mockedGetCatalog).toHaveBeenCalledTimes(1);
      expect(mockedGetCatalog).toHaveBeenCalledWith(user.id, validFence);
    });

    const errorMappingCases: Array<[LocalRuntimeControlErrorCode, TRPCError['code']]> = [
      ['RUNTIME_NOT_CONNECTED', 'NOT_FOUND'],
      ['RUNTIME_FENCE_MISMATCH', 'CONFLICT'],
      ['CATALOG_CHANGED', 'CONFLICT'],
      ['COMMAND_ALREADY_PENDING', 'CONFLICT'],
      ['CLI_UPGRADE_REQUIRED', 'PRECONDITION_FAILED'],
      ['COMMAND_EXPIRED', 'TIMEOUT'],
      ['PENDING_COMMAND_LIMIT', 'TOO_MANY_REQUESTS'],
      ['COMMAND_NOT_ALLOWED', 'FORBIDDEN'],
      ['RESULT_TOO_LARGE', 'INTERNAL_SERVER_ERROR'],
      ['INVALID_RUNTIME_RESPONSE', 'INTERNAL_SERVER_ERROR'],
      ['RUNTIME_COMMAND_FAILED', 'INTERNAL_SERVER_ERROR'],
    ];

    it.each(errorMappingCases)(
      'maps %s to a %s tRPC error with the upstream code in cause and data',
      async (upstreamCode, expectedCode) => {
        mockedGetCatalog.mockRejectedValueOnce(
          new LocalRuntimeCatalogError(upstreamCode, 'upstream message')
        );

        const caller = await createCallerForUser(user.id);
        try {
          await caller.localRuntimeControl.getCatalog(validFence);
          throw new Error('Expected getCatalog to reject');
        } catch (err) {
          expect(err).toBeInstanceOf(TRPCError);
          if (!(err instanceof TRPCError)) throw err;
          expect(err.code).toBe(expectedCode);
          expect(err.cause).toBeInstanceOf(UpstreamApiError);
          if (!(err.cause instanceof UpstreamApiError)) throw err;
          expect(err.cause.upstreamCode).toBe(upstreamCode);
        }
      }
    );

    it('maps an unknown upstream code to INTERNAL_SERVER_ERROR', async () => {
      mockedGetCatalog.mockRejectedValueOnce(
        new LocalRuntimeCatalogError('UNKNOWN', 'upstream message')
      );

      const caller = await createCallerForUser(user.id);
      try {
        await caller.localRuntimeControl.getCatalog(validFence);
        throw new Error('Expected getCatalog to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(TRPCError);
        if (!(err instanceof TRPCError)) throw err;
        expect(err.code).toBe('INTERNAL_SERVER_ERROR');
        expect(err.cause).toBeInstanceOf(UpstreamApiError);
        if (!(err.cause instanceof UpstreamApiError)) throw err;
        expect(err.cause.upstreamCode).toBe('UNKNOWN');
      }
    });
  });

  it('does not define any mutation procedures', () => {
    const procedureNames = Object.keys(rootRouter._def.procedures).filter(name =>
      name.startsWith('localRuntimeControl.')
    );
    expect(procedureNames).toEqual(['localRuntimeControl.list', 'localRuntimeControl.getCatalog']);
  });
});
