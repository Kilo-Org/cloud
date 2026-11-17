import { describe, expect, it } from '@jest/globals';
import type { jest as JestGlobal } from '@jest/globals';

// `jest.mock` is hoisted above the compiled `require`s only when it is called on
// the global `jest`. Calling it on the `@jest/globals` import binding compiles to
// `_globals.jest.mock(...)`, which the transform leaves below the imports, so the
// mocks registered after `pg` was first required and never applied.
declare const jest: typeof JestGlobal;

jest.mock('pg', () => {
  const Pool = jest.fn(function Pool(this: object) {
    return this;
  });

  const types = {
    builtins: { INT8: 20 },
    setTypeParser: jest.fn(),
    getTypeParser: jest.fn(),
  };

  return {
    __esModule: true,
    default: { Pool, types },
    types,
  };
});

jest.mock('drizzle-orm/node-postgres', () => ({
  drizzle: jest.fn((pool: object) => ({ pool })),
}));

import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { types } from 'pg';
import { createDrizzleClient, databaseTypeParsers, getWorkerDb } from './client';

const workerConnectionString = 'postgres://worker.example/db';

describe('getWorkerDb', () => {
  it('creates separate Worker DB transports for identical inputs', () => {
    const firstDb = getWorkerDb(workerConnectionString);
    const secondDb = getWorkerDb(workerConnectionString);
    const drizzleMock = jest.mocked(drizzle);

    expect(pg.Pool).toHaveBeenNthCalledWith(1, {
      connectionString: workerConnectionString,
      max: 1,
      types: databaseTypeParsers,
    });
    expect(pg.Pool).toHaveBeenNthCalledWith(2, {
      connectionString: workerConnectionString,
      max: 1,
      types: databaseTypeParsers,
    });
    expect(drizzleMock.mock.calls[0]?.[0]).not.toBe(drizzleMock.mock.calls[1]?.[0]);
    expect(firstDb).not.toBe(secondDb);
  });
});

describe('createDrizzleClient', () => {
  it('scopes the int8 parsers to the pool it creates', () => {
    createDrizzleClient({ connectionString: 'postgres://primary.example/db' });

    expect(pg.Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({ types: databaseTypeParsers })
    );
  });
});

// Compile-time guards: the helpers own the int8 parser, so their option types must reject
// `types`. `tsgo --noEmit` compiles this file, so a re-widened type makes these
// `@ts-expect-error` directives unused and the typecheck fails.
type WorkerOptions = Parameters<typeof getWorkerDb>[1];
type PoolConfigOption = NonNullable<Parameters<typeof createDrizzleClient>[0]['poolConfig']>;

const acceptsWorkerSetting: WorkerOptions = { application_name: 'worker', statement_timeout: 1000 };
// @ts-expect-error getWorkerDb installs databaseTypeParsers on its pool.
const workerTypes: WorkerOptions = { types: databaseTypeParsers };
const acceptsPoolSetting: PoolConfigOption = {
  application_name: 'local-kilo-script',
  max: 10,
};
// @ts-expect-error createDrizzleClient installs databaseTypeParsers on its pool.
const poolTypes: PoolConfigOption = { types: databaseTypeParsers };

void acceptsWorkerSetting;
void acceptsPoolSetting;
void workerTypes;
void poolTypes;

describe('databaseTypeParsers', () => {
  it('reads int8 as BigInt', () => {
    const parse = databaseTypeParsers.getTypeParser(types.builtins.INT8, 'text');

    expect(parse('9223372036854775807')).toBe(BigInt('9223372036854775807'));
  });

  it('leaves every other type to the client', () => {
    const delegated = (value: string) => value;
    jest.mocked(types.getTypeParser).mockReturnValue(delegated);

    expect(databaseTypeParsers.getTypeParser(23, 'text')).toBe(delegated);
    expect(types.getTypeParser).toHaveBeenLastCalledWith(23, 'text');
  });

  it('leaves the binary int8 format to the client', () => {
    const delegated = (value: string) => value;
    jest.mocked(types.getTypeParser).mockReturnValue(delegated);

    expect(databaseTypeParsers.getTypeParser(types.builtins.INT8, 'binary')).toBe(delegated);
    expect(types.getTypeParser).toHaveBeenLastCalledWith(types.builtins.INT8, 'binary');
  });
});
