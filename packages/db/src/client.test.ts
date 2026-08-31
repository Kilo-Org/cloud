import { describe, expect, it, jest } from '@jest/globals';

jest.mock('pg', () => {
  const Pool = jest.fn(function Pool(this: object) {
    return this;
  });

  return {
    __esModule: true,
    default: {
      Pool,
      types: {
        builtins: { INT8: 20 },
        setTypeParser: jest.fn(),
      },
    },
    types: {
      builtins: { INT8: 20 },
      setTypeParser: jest.fn(),
    },
  };
});

jest.mock('drizzle-orm/node-postgres', () => ({
  drizzle: jest.fn((pool: object) => ({ pool })),
}));

describe('getWorkerDb', () => {
  it('creates separate Worker DB transports for identical inputs', async () => {
    // SWC does not hoist imported jest.mock calls; workerSetup also caches the real client.
    await jest.isolateModulesAsync(async () => {
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { default: pg } = await import('pg');
      const { getWorkerDb } = await import('./client');
      const connectionString = 'postgres://worker.example/db';
      const firstDb = getWorkerDb(connectionString);
      const secondDb = getWorkerDb(connectionString);
      const poolMock = jest.mocked(pg.Pool);
      const drizzleMock = jest.mocked(drizzle);

      expect(poolMock).toHaveBeenCalledTimes(2);
      expect(pg.Pool).toHaveBeenNthCalledWith(1, { connectionString, max: 1 });
      expect(pg.Pool).toHaveBeenNthCalledWith(2, { connectionString, max: 1 });
      expect(drizzleMock).toHaveBeenCalledTimes(2);
      expect(drizzleMock.mock.calls[0]?.[0]).toBe(poolMock.mock.instances[0]);
      expect(drizzleMock.mock.calls[1]?.[0]).toBe(poolMock.mock.instances[1]);
      expect(drizzleMock.mock.calls[0]?.[0]).not.toBe(drizzleMock.mock.calls[1]?.[0]);
      expect(firstDb).toBe(drizzleMock.mock.results[0]?.value);
      expect(secondDb).toBe(drizzleMock.mock.results[1]?.value);
      expect(firstDb).not.toBe(secondDb);
    });
  });
});
