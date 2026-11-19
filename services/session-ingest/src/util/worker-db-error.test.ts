import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describeWorkerDbError } from './worker-db-error';

function databaseError(message: string, fields: Record<string, string>) {
  return Object.assign(new Error(message), { name: 'error', ...fields });
}

describe('describeWorkerDbError', () => {
  it('reports the SQLSTATE of a failed query without its parameters', () => {
    const error = new DrizzleQueryError(
      'update "cli_sessions_v2" set "last_activity_at" = $1 where "kilo_user_id" = $2',
      ['2026-11-18T22:10:00.000Z', 'oauth/secret-user'],
      databaseError('canceling statement due to lock timeout', {
        code: '55P03',
        severity: 'ERROR',
        routine: 'ProcessInterrupts',
        detail: 'row value oauth/secret-user',
      })
    );

    const description = describeWorkerDbError(error);

    expect(description.error).toBe(
      'Failed query: update "cli_sessions_v2" set "last_activity_at" = $1 where "kilo_user_id" = $2'
    );
    expect(description.causes).toEqual([
      {
        name: 'error',
        code: '55P03',
        severity: 'ERROR',
        routine: 'ProcessInterrupts',
        message: 'canceling statement due to lock timeout',
      },
    ]);
    expect(JSON.stringify(description)).not.toContain('secret-user');
  });

  it('reports a pool failure that has no SQLSTATE', () => {
    const error = new DrizzleQueryError(
      'begin',
      [],
      new Error('timeout exceeded when trying to connect')
    );

    expect(describeWorkerDbError(error).causes).toEqual([
      { name: 'Error', message: 'timeout exceeded when trying to connect' },
    ]);
  });

  it('leaves out messages that quote rejected input', () => {
    const error = new DrizzleQueryError(
      'select 1 where "id" = $1',
      ['not-a-uuid'],
      databaseError('invalid input syntax for type uuid: "not-a-uuid"', { code: '22P02' })
    );

    const description = describeWorkerDbError(error);

    expect(description.causes).toEqual([{ name: 'error', code: '22P02' }]);
    expect(JSON.stringify(description)).not.toContain('not-a-uuid');
  });

  it('follows nested causes and accepts non-Error values', () => {
    const inner = databaseError('terminating connection due to idle-in-transaction timeout', {
      code: '25P03',
    });
    const outer = new Error('Worker database connection failed', { cause: inner });

    expect(describeWorkerDbError(outer).causes).toEqual([
      {
        name: 'error',
        code: '25P03',
        message: 'terminating connection due to idle-in-transaction timeout',
      },
    ]);
    expect(describeWorkerDbError('plain')).toEqual({ error: 'plain' });
  });
});
