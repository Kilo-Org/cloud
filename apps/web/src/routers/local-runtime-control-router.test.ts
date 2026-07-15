import { jest } from '@jest/globals';
import type * as LocalRuntimeControlClientModule from '@/lib/local-runtime-control/client';
import type * as TestUtilsModule from '@/routers/test-utils';
import type * as RootRouterModule from '@/routers/root-router';
import type * as UserHelperModule from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

jest.mock('@/lib/local-runtime-control/client', () => {
  const { LocalRuntimeControlRequestError } = jest.requireActual<
    typeof LocalRuntimeControlClientModule
  >('@/lib/local-runtime-control/client');
  return {
    LocalRuntimeControlRequestError,
    LocalRuntimeControlClient: {
      list: jest.fn(),
    },
  };
});

const mockedList = jest.mocked(
  jest.requireMock<typeof LocalRuntimeControlClientModule>('@/lib/local-runtime-control/client')
    .LocalRuntimeControlClient.list
);

const { LocalRuntimeControlRequestError } = jest.requireActual<
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

  it('does not define any mutation procedures', () => {
    const procedureNames = Object.keys(rootRouter._def.procedures).filter(name =>
      name.startsWith('localRuntimeControl.')
    );
    expect(procedureNames).toEqual(['localRuntimeControl.list']);
  });
});
