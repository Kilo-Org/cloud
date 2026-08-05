import {
  applyWithRetries,
  findFailingQuery,
  findPostgresError,
  findTransactionBreakingMigrations,
  MigrationSafetyError,
  reportFailure,
} from './migrate';

/** Shaped like a `pg` error: the code lives on the error object itself. */
function postgresError(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

/** Shaped like DrizzleQueryError: the pg error is the `cause`. */
function wrappedPostgresError(code: string, query: string): Error {
  return Object.assign(new Error(`Failed query: ${query}`), {
    query,
    cause: postgresError(code, 'deadlock detected'),
  });
}

const noSleep = async () => {};

describe('findPostgresError', () => {
  it('reads the code off a bare pg error', () => {
    expect(findPostgresError(postgresError('40P01'))?.code).toBe('40P01');
  });

  it('unwraps the cause chain that drizzle wraps the pg error in', () => {
    const error = wrappedPostgresError('40P01', 'drop table "x"');

    expect(findPostgresError(error)?.code).toBe('40P01');
    expect(findPostgresError(error)?.message).toBe('deadlock detected');
  });

  it('returns undefined when nothing in the chain carries a code', () => {
    expect(findPostgresError(new Error('plain'))).toBeUndefined();
    expect(findPostgresError('not an error')).toBeUndefined();
  });

  it('surfaces the fields drizzle-kit discards', () => {
    const error = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
      detail: 'Process 123 waits for AccessExclusiveLock on relation 456',
      hint: 'See server log for query details.',
      table: 'organizations',
    });

    expect(findPostgresError(error)).toMatchObject({
      code: '40P01',
      detail: 'Process 123 waits for AccessExclusiveLock on relation 456',
      hint: 'See server log for query details.',
      table: 'organizations',
    });
  });
});

describe('findFailingQuery', () => {
  it('reads the query drizzle attaches to the wrapper', () => {
    expect(findFailingQuery(wrappedPostgresError('55P03', 'drop table "y"'))).toBe(
      'drop table "y"'
    );
  });

  it('returns undefined when no wrapper carries a query', () => {
    expect(findFailingQuery(postgresError('55P03'))).toBeUndefined();
  });
});

describe('findTransactionBreakingMigrations', () => {
  it('flags a migration that commits mid-file for CONCURRENTLY', () => {
    const pending = [
      {
        tag: '0193_concurrent_index',
        sql: [
          'ALTER TABLE "a" DROP CONSTRAINT "b";',
          'COMMIT;',
          'CREATE INDEX CONCURRENTLY "idx" ON "a" ("c");',
          'BEGIN;',
        ].join('--> statement-breakpoint'),
      },
    ];

    expect(findTransactionBreakingMigrations(pending)).toEqual(['0193_concurrent_index']);
  });

  it('ignores ordinary DDL', () => {
    const pending = [
      { tag: '0204_drop_tables', sql: 'DROP TABLE IF EXISTS "x" CASCADE;' },
      { tag: '0205_add_column', sql: 'ALTER TABLE "y" ADD COLUMN "z" text;' },
    ];

    expect(findTransactionBreakingMigrations(pending)).toEqual([]);
  });

  it('does not mistake COMMIT inside an identifier or comment for a statement', () => {
    const pending = [
      { tag: '0206_commit_column', sql: 'ALTER TABLE "kiloclaw" ADD COLUMN "commit_sha" text;' },
    ];

    expect(findTransactionBreakingMigrations(pending)).toEqual([]);
  });
});

describe('reportFailure', () => {
  let errors: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    errors = [];
    spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => spy.mockRestore());

  it('reports a safety refusal without a stack trace', () => {
    reportFailure(new MigrationSafetyError('lock_timeout is disabled'));

    expect(errors).toEqual(['[migrate] refusing to run: lock_timeout is disabled']);
  });

  it('reports the pg fields drizzle-kit discards', () => {
    reportFailure(
      Object.assign(new Error('Failed query: drop table "x"'), {
        query: 'drop table "x"',
        cause: Object.assign(new Error('deadlock detected'), {
          code: '40P01',
          detail: 'Process 1 waits for AccessExclusiveLock',
        }),
      })
    );

    expect(errors.join('\n')).toContain('[migrate] migration failed: 40P01');
    expect(errors.join('\n')).toContain('detail: Process 1 waits for AccessExclusiveLock');
    expect(errors.join('\n')).toContain('failing statement: drop table "x"');
  });
});

describe('applyWithRetries', () => {
  it('returns the attempt count on first success', async () => {
    const apply = jest.fn(async () => {});

    await expect(applyWithRetries(apply, 5, noSleep)).resolves.toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it.each(['40P01', '55P03', '40001'])('retries %s until it succeeds', async code => {
    let calls = 0;
    const apply = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw postgresError(code);
    });

    await expect(applyWithRetries(apply, 5, noSleep)).resolves.toBe(3);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it('retries a lock failure that drizzle wrapped', async () => {
    let calls = 0;
    const apply = jest.fn(async () => {
      calls += 1;
      if (calls < 2) throw wrappedPostgresError('55P03', 'drop table "x"');
    });

    await expect(applyWithRetries(apply, 3, noSleep)).resolves.toBe(2);
  });

  it('gives up after maxAttempts and rethrows the lock failure', async () => {
    const apply = jest.fn(async () => {
      throw postgresError('55P03');
    });

    await expect(applyWithRetries(apply, 3, noSleep)).rejects.toMatchObject({ code: '55P03' });
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it('does not retry a real migration bug', async () => {
    // 42P01 undefined_table: replaying this would never help.
    const apply = jest.fn(async () => {
      throw postgresError('42P01', 'relation "gone" does not exist');
    });

    await expect(applyWithRetries(apply, 5, noSleep)).rejects.toMatchObject({ code: '42P01' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error with no pg code', async () => {
    const apply = jest.fn(async () => {
      throw new Error('connection terminated');
    });

    await expect(applyWithRetries(apply, 5, noSleep)).rejects.toThrow('connection terminated');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('honours maxAttempts of 1 for migrations that cannot be replayed', async () => {
    const apply = jest.fn(async () => {
      throw postgresError('40P01');
    });

    await expect(applyWithRetries(apply, 1, noSleep)).rejects.toMatchObject({ code: '40P01' });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
