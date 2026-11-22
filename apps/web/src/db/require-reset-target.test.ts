import { describe, expect, it } from '@jest/globals';
import { resolveResetTarget } from './require-reset-target';

const APP_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

describe('resolveResetTarget', () => {
  it('inherits the app connection when the script variable is unset', () => {
    expect(resolveResetTarget(APP_URL, undefined)).toEqual({ kind: 'use', scriptUrl: APP_URL });
    expect(resolveResetTarget(APP_URL, '')).toEqual({ kind: 'use', scriptUrl: APP_URL });
  });

  it('uses the script connection when only it is set', () => {
    expect(resolveResetTarget(undefined, APP_URL)).toEqual({ kind: 'use', scriptUrl: APP_URL });
  });

  it('refuses when neither variable is set', () => {
    expect(resolveResetTarget(undefined, undefined)).toEqual({
      kind: 'refuse',
      reason: 'both-unset',
    });
  });

  it('accepts two spellings of the same database', () => {
    expect(
      resolveResetTarget(
        'postgresql://postgres:postgres@localhost:5432/postgres',
        'postgres://postgres:postgres@localhost:5432/postgres'
      )
    ).toEqual({ kind: 'use', scriptUrl: 'postgres://postgres:postgres@localhost:5432/postgres' });
  });

  it('refuses two databases on one host', () => {
    expect(
      resolveResetTarget(APP_URL, 'postgres://postgres:postgres@localhost:5432/scripts')
    ).toEqual({ kind: 'refuse', reason: 'different-databases' });
  });

  it('refuses two hosts that carry the same database name', () => {
    expect(
      resolveResetTarget(APP_URL, 'postgres://postgres:postgres@db.example.com:5432/postgres')
    ).toEqual({ kind: 'refuse', reason: 'different-databases' });
  });

  it('refuses a value that is not a connection URL', () => {
    expect(resolveResetTarget(APP_URL, 'not-a-connection-url')).toEqual({
      kind: 'refuse',
      reason: 'unparseable',
    });
    expect(resolveResetTarget('not-a-connection-url', APP_URL)).toEqual({
      kind: 'refuse',
      reason: 'unparseable',
    });
  });
});
