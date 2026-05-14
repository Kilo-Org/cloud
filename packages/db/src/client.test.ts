import { describe, expect, it, jest } from '@jest/globals';

jest.mock('pg', () => {
  class Pool {}

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
  drizzle: jest.fn((pool: unknown) => ({ pool })),
}));

import { drizzle } from 'drizzle-orm/node-postgres';
import { getWorkerDb } from './client';

describe('getWorkerDb', () => {
  it('returns a fresh Worker database object for every call', () => {
    const firstDb = getWorkerDb('postgres://worker.example/db');
    const secondDb = getWorkerDb('postgres://worker.example/db');

    expect(firstDb).not.toBe(secondDb);
    expect(drizzle).toHaveBeenCalledTimes(2);
  });
});
