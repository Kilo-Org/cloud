import { describe, expect, it } from '@jest/globals';
import type { jest as JestGlobal } from '@jest/globals';

// `jest.mock` is hoisted above the compiled `require`s only when it is called on
// the global `jest`. Calling it on the `@jest/globals` import binding compiles to
// `_globals.jest.mock(...)`, which the transform leaves below the imports, so the
// mocks registered after `pg` was first required and never applied.
declare const jest: typeof JestGlobal;

jest.mock('pg', () => {
  const Pool = jest.fn(function Pool(this: { on: unknown }) {
    this.on = jest.fn();
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
      connectionTimeoutMillis: 15_000,
      connectionString: workerConnectionString,
      max: 1,
      maxUses: 1,
      types: databaseTypeParsers,
    });
    expect(pg.Pool).toHaveBeenNthCalledWith(2, {
      connectionTimeoutMillis: 15_000,
      connectionString: workerConnectionString,
      max: 1,
      maxUses: 1,
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

  it('keeps the reserved connection settings authoritative for a widened poolConfig', () => {
    delete process.env.DATABASE_CA;
    const widened: pg.PoolConfig = {
      connectionString: 'postgres://widener:widener-secret@widened.example:6543/widened',
      user: 'widener',
      password: 'widener-secret',
      host: 'widened.example',
      port: 6543,
      database: 'widened',
      ssl: { ca: 'widened' },
      types: { getTypeParser: jest.fn() },
      max: 7,
      application_name: 'widened-pool',
    };

    createDrizzleClient({
      connectionString: 'postgres://alice:secret@derived.example:5432/derived',
      poolConfig: widened,
    });

    expect(pg.Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        user: 'alice',
        password: 'secret',
        host: 'derived.example',
        port: 5432,
        database: 'derived',
        ssl: false,
        types: databaseTypeParsers,
        max: 7,
        application_name: 'widened-pool',
      })
    );
    const calls = jest.mocked(pg.Pool).mock.calls;
    const config = calls[calls.length - 1]?.[0] as pg.PoolConfig;
    expect(Object.hasOwn(config, 'connectionString')).toBe(true);
    expect(config.connectionString).toBeUndefined();
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
// @ts-expect-error getWorkerDb owns the lock bound of each transaction.
const workerLockTimeout: WorkerOptions = { lock_timeout: 1000 };
// @ts-expect-error getWorkerDb closes each connection after one use.
const workerMaxUses: WorkerOptions = { maxUses: 10 };
const acceptsPoolSetting: PoolConfigOption = {
  application_name: 'local-kilo-script',
  max: 10,
};
// @ts-expect-error createDrizzleClient installs databaseTypeParsers on its pool.
const poolTypes: PoolConfigOption = { types: databaseTypeParsers };
// @ts-expect-error createDrizzleClient derives the connection fields from its `connectionString` argument.
const poolConnectionString: PoolConfigOption = { connectionString: 'postgres://other.example/db' };
// @ts-expect-error createDrizzleClient parses `user` from its `connectionString` argument.
const poolUser: PoolConfigOption = { user: 'someone' };
// @ts-expect-error createDrizzleClient parses `password` from its `connectionString` argument.
const poolPassword: PoolConfigOption = { password: 'secret' };
// @ts-expect-error createDrizzleClient parses `host` from its `connectionString` argument.
const poolHost: PoolConfigOption = { host: 'other.example' };
// @ts-expect-error createDrizzleClient parses `port` from its `connectionString` argument.
const poolPort: PoolConfigOption = { port: 5432 };
// @ts-expect-error createDrizzleClient parses `database` from its `connectionString` argument.
const poolDatabase: PoolConfigOption = { database: 'other' };
// @ts-expect-error createDrizzleClient owns TLS; the dedicated `ssl` option replaces it.
const poolSsl: PoolConfigOption = { ssl: { ca: 'ca' } };

void acceptsWorkerSetting;
void acceptsPoolSetting;
void workerTypes;
void workerLockTimeout;
void workerMaxUses;
void poolTypes;
void poolConnectionString;
void poolUser;
void poolPassword;
void poolHost;
void poolPort;
void poolDatabase;
void poolSsl;

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
