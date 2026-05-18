import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { withKiloclawProvisionContextLock as WithKiloclawProvisionContextLock } from './provision-lock';

jest.mock('@vercel/functions', () => ({
  attachDatabasePool: jest.fn(),
}));

jest.mock('@kilocode/db', () => ({
  computeDatabaseUrl: jest.fn(() => 'postgres://provision-lock-test'),
}));

jest.mock('@kilocode/db/client', () => {
  const connectMock = jest.fn();
  const onMock = jest.fn();

  return {
    createDrizzleClient: jest.fn(() => ({
      pool: {
        connect: connectMock,
        on: onMock,
      },
    })),
    __connectMock: connectMock,
  };
});

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
type ReleaseMock = jest.Mock<(...args: unknown[]) => void>;
type ProvisionLockClientMock = {
  query: AsyncMock;
  release: ReleaseMock;
};
type DrizzleClientModuleMock = {
  __connectMock: AsyncMock;
};

const { __connectMock: connectMock } =
  jest.requireMock<DrizzleClientModuleMock>('@kilocode/db/client');

let withKiloclawProvisionContextLock: typeof WithKiloclawProvisionContextLock;

beforeAll(async () => {
  const provisionLockModule = await import('./provision-lock');
  withKiloclawProvisionContextLock = provisionLockModule.withKiloclawProvisionContextLock;
});

function createProvisionLockClient(): ProvisionLockClientMock {
  return {
    query: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    release: jest.fn<(...args: unknown[]) => void>(),
  };
}

function queueProvisionLockClient(client: ProvisionLockClientMock): void {
  connectMock.mockResolvedValueOnce(client);
}

function prepareSuccessfulLockLifecycle(client: ProvisionLockClientMock): void {
  client.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
}

describe('withKiloclawProvisionContextLock', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('acquires the context lock, runs work, unlocks, and returns a reusable client', async () => {
    const client = createProvisionLockClient();
    const work = jest.fn(async () => 'provisioned');
    prepareSuccessfulLockLifecycle(client);
    queueProvisionLockClient(client);

    await expect(withKiloclawProvisionContextLock('normal-key', work)).resolves.toBe('provisioned');

    expect(work).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_lock(hashtext($1))', [
      'normal-key',
    ]);
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
      ['normal-key']
    );
    expect(client.release.mock.calls).toEqual([[]]);
  });

  it('unlocks and returns a reusable client when work throws', async () => {
    const client = createProvisionLockClient();
    prepareSuccessfulLockLifecycle(client);
    queueProvisionLockClient(client);

    await expect(
      withKiloclawProvisionContextLock('work-failure-key', async () => {
        throw new Error('provision work failed');
      })
    ).rejects.toThrow('provision work failed');

    expect(client.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
      ['work-failure-key']
    );
    expect(client.release.mock.calls).toEqual([[]]);
  });

  it('discards the client while preserving the work result when unlock throws', async () => {
    const client = createProvisionLockClient();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('unlock transport failed'));
    queueProvisionLockClient(client);

    await expect(
      withKiloclawProvisionContextLock('unlock-throw-key', async () => 'completed')
    ).resolves.toBe('completed');

    expect(client.release).toHaveBeenCalledWith(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[kiloclaw] Failed to release provision context lock',
      {
        lockKey: 'unlock-throw-key',
        error: 'unlock transport failed',
      }
    );
    consoleErrorSpy.mockRestore();
  });

  it('discards the client when PostgreSQL does not confirm unlock cleanup', async () => {
    const client = createProvisionLockClient();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ unlocked: false }] });
    queueProvisionLockClient(client);

    await expect(
      withKiloclawProvisionContextLock('unlock-false-key', async () => 'completed')
    ).resolves.toBe('completed');

    expect(client.release).toHaveBeenCalledWith(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[kiloclaw] Failed to release provision context lock',
      {
        lockKey: 'unlock-false-key',
        error: 'PostgreSQL did not confirm provision context lock release',
      }
    );
    consoleErrorSpy.mockRestore();
  });

  it('discards the client and skips work when lock acquisition times out', async () => {
    const client = createProvisionLockClient();
    const work = jest.fn(async () => 'must not run');
    client.query.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    queueProvisionLockClient(client);

    await expect(withKiloclawProvisionContextLock('acquire-timeout-key', work)).rejects.toThrow(
      'canceling statement due to statement timeout'
    );

    expect(work).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('prevents later checkouts from reusing a client whose unlock state is uncertain', async () => {
    const contaminatedClient = createProvisionLockClient();
    const cleanClient = createProvisionLockClient();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let contaminatedClientDiscarded = false;

    contaminatedClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('unlock cancelled'));
    contaminatedClient.release.mockImplementation(discard => {
      contaminatedClientDiscarded = discard === true;
    });
    prepareSuccessfulLockLifecycle(cleanClient);
    connectMock.mockImplementation(async () =>
      contaminatedClientDiscarded ? cleanClient : contaminatedClient
    );

    await expect(
      withKiloclawProvisionContextLock('contaminated-key', async () => 'first')
    ).resolves.toBe('first');
    await expect(withKiloclawProvisionContextLock('clean-key', async () => 'second')).resolves.toBe(
      'second'
    );

    expect(contaminatedClient.release).toHaveBeenCalledWith(true);
    expect(cleanClient.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_lock(hashtext($1))', [
      'clean-key',
    ]);
    expect(cleanClient.release.mock.calls).toEqual([[]]);
    consoleErrorSpy.mockRestore();
  });
});
