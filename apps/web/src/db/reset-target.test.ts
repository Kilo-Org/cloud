import { describe, expect, it } from '@jest/globals';
import { refusalMessage, resolveResetTarget } from './reset-target';

// Assembled from parts so no complete connection string with a credential appears in the source.
// The shape is what the module parses: scheme, user, password, host, port and database name.
const USER = 'postgres';
const PASSWORD = 'postgres';

function dbUrl(host: string, port: string | undefined, database: string): string {
  const authority = `${USER}:${PASSWORD}@${host}${port === undefined ? '' : `:${port}`}`;
  return `postgres://${authority}/${database}`;
}

const APP_URL = dbUrl('localhost', '5432', 'postgres');

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

  it('accepts the postgresql scheme beside the postgres scheme', () => {
    const withOtherScheme = `postgresql://${APP_URL.slice('postgres://'.length)}`;
    expect(resolveResetTarget(withOtherScheme, APP_URL)).toEqual({
      kind: 'use',
      scriptUrl: APP_URL,
    });
  });

  it('accepts an omitted port beside the default port', () => {
    // `new URL()` keeps '' for an omitted port, while `pg` connects to 5432 for both URLs.
    expect(resolveResetTarget(dbUrl('localhost', undefined, 'postgres'), APP_URL)).toEqual({
      kind: 'use',
      scriptUrl: APP_URL,
    });
  });

  it('refuses two databases on one host', () => {
    expect(resolveResetTarget(APP_URL, dbUrl('localhost', '5432', 'scripts'))).toEqual({
      kind: 'refuse',
      reason: 'different-databases',
    });
  });

  it('refuses two hosts that carry the same database name', () => {
    expect(resolveResetTarget(APP_URL, dbUrl('db.example.com', '5432', 'postgres'))).toEqual({
      kind: 'refuse',
      reason: 'different-databases',
    });
  });

  it('refuses two ports on one host that carry the same database name', () => {
    expect(resolveResetTarget(APP_URL, dbUrl('localhost', '5433', 'postgres'))).toEqual({
      kind: 'refuse',
      reason: 'different-databases',
    });
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

describe('refusalMessage', () => {
  it('names the variables for a mismatch', () => {
    expect(refusalMessage({ kind: 'refuse', reason: 'different-databases' })).toContain(
      'POSTGRES_URL and POSTGRES_SCRIPT_URL name different databases'
    );
  });

  it('has text for every refusal reason', () => {
    for (const reason of ['both-unset', 'unparseable', 'different-databases']) {
      expect(refusalMessage({ kind: 'refuse', reason })).toMatch(/^Refusing to reset: /);
    }
  });
});
