import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alterLoginPassword, type DirectTarget } from '../../src/rotation/postgres';
import { scramVerifier } from '../../src/rotation/scram';
import { adminUrl, withAdmin } from './connection';

/**
 * A throwaway login of this file only, so no other suite's UTS login password changes. It defaults
 * to read-only transactions, as the `uts_reader` logins do, which a plain ALTER ROLE would hit.
 */
const LOGIN = 'uts_rotation_probe';
const first = `first-${randomUUID()}`;
const target: DirectTarget = (() => {
  const url = new URL(adminUrl());
  return { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1) };
})();

async function logsIn(password: string): Promise<boolean> {
  const client = new pg.Client({ ...target, user: LOGIN, password });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  await withAdmin(undefined, async client => {
    await client.query(`DROP ROLE IF EXISTS ${LOGIN}`);
    await client.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${await scramVerifier(first)}'`);
    await client.query(`ALTER ROLE ${LOGIN} SET default_transaction_read_only = on`);
  });
});

afterAll(async () => {
  await withAdmin(undefined, client => client.query(`DROP ROLE IF EXISTS ${LOGIN}`));
});

describe('the direct ALTER of the login rotation', () => {
  it('stores a SCRAM verifier that PostgreSQL accepts for the password', async () => {
    expect(await logsIn(first)).toBe(true);
    expect(await logsIn('another')).toBe(false);
  });

  it('changes the password as the login itself, then finds it applied on a second run', async () => {
    const pending = `pending-${randomUUID()}`;
    expect(await alterLoginPassword(target, LOGIN, first, pending)).toEqual({ status: 'altered' });
    expect(await logsIn(pending)).toBe(true);
    expect(await logsIn(first)).toBe(false);
    expect(await alterLoginPassword(target, LOGIN, first, pending)).toEqual({
      status: 'already_applied',
    });
  });

  it('reports a login that neither password opens, and an unreachable server', async () => {
    expect(await alterLoginPassword(target, LOGIN, 'wrong-1', 'wrong-2')).toEqual({
      status: 'auth_failed',
    });
    expect(await alterLoginPassword({ ...target, port: 1 }, LOGIN, 'a', 'b')).toEqual({
      status: 'unreachable',
      detail: 'connection failed',
    });
  });
});
