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

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getWorkerDb } from './client';

describe('getWorkerDb', () => {
  it('creates separate Worker DB transports for identical inputs', () => {
    const connectionString = 'postgres://worker.example/db';
    const firstDb = getWorkerDb(connectionString);
    const secondDb = getWorkerDb(connectionString);
    const drizzleMock = jest.mocked(drizzle);

    expect(pg.Pool).toHaveBeenNthCalledWith(1, { connectionString, max: 1 });
    expect(pg.Pool).toHaveBeenNthCalledWith(2, { connectionString, max: 1 });
    expect(drizzleMock.mock.calls[0]?.[0]).not.toBe(drizzleMock.mock.calls[1]?.[0]);
    expect(firstDb).not.toBe(secondDb);
  });
});
