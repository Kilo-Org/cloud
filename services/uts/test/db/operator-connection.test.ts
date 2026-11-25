import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionPolicyError, operatorClientConfig } from '../../scripts/connection';
import { NonLocalDatabaseError, adminUrl } from './connection';

const readCa = (path: string) => `ca from ${path}`;

describe('operator connections', () => {
  it.each([
    'postgres://admin:secret@127.0.0.1:55432/uts',
    'postgres://admin:secret@localhost/uts',
    'postgresql://admin:secret@[::1]:5432/uts',
  ])('allow plaintext to the loopback host in %s', url => {
    expect(operatorClientConfig(url, readCa)).toMatchObject({ ssl: false });
  });

  it('use verified TLS with the given CA for a remote host', () => {
    expect(
      operatorClientConfig(
        'postgres://admin:p%40ss@db.example.com:6543/postgres?sslmode=verify-full&sslrootcert=/etc/ca.pem',
        readCa
      )
    ).toEqual({
      host: 'db.example.com',
      port: 6543,
      database: 'postgres',
      user: 'admin',
      password: 'p@ss',
      ssl: { ca: 'ca from /etc/ca.pem', rejectUnauthorized: true },
    });
  });

  it.each([
    ['plaintext to a remote host', 'postgres://admin:secret@db.example.com/postgres'],
    ['an unverified TLS mode', 'postgres://admin:secret@db.example.com/postgres?sslmode=require'],
    [
      'verify-full without a CA',
      'postgres://admin:secret@db.example.com/postgres?sslmode=verify-full',
    ],
    [
      'a CA without verify-full',
      'postgres://admin:secret@db.example.com/postgres?sslrootcert=/etc/ca.pem',
    ],
    [
      'another URL parameter',
      'postgres://admin:secret@db.example.com/postgres?sslmode=verify-full&sslrootcert=/ca&ssl=0',
    ],
    ['another protocol', 'mysql://admin:secret@127.0.0.1/uts'],
  ])('refuse %s', (_name, url) => {
    expect(() => operatorClientConfig(url, readCa)).toThrow(ConnectionPolicyError);
  });

  it('connect to the local database', async () => {
    const client = new pg.Client(operatorClientConfig(adminUrl()));
    await client.connect();
    try {
      const result = await client.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'
      );
      expect(result.rows).toEqual([{ ssl: false }]);
    } finally {
      await client.end();
    }
  });
});

describe('the test database guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuse an admin URL whose host is not loopback', () => {
    vi.stubEnv('UTS_TEST_ADMIN_URL', 'postgres://postgres:secret@db.example.com:5432/postgres');
    expect(() => adminUrl()).toThrow(NonLocalDatabaseError);
  });

  it('refuse a loopback admin URL with a query parameter, which could name another host', () => {
    vi.stubEnv(
      'UTS_TEST_ADMIN_URL',
      'postgres://postgres:secret@127.0.0.1:5432/postgres?host=db.example.com'
    );
    expect(() => adminUrl()).toThrow(NonLocalDatabaseError);
  });

  it('accept a loopback admin URL', () => {
    vi.stubEnv('UTS_TEST_ADMIN_URL', 'postgres://uts_admin:local@localhost:55432/uts');
    expect(adminUrl()).toBe('postgres://uts_admin:local@localhost:55432/uts');
  });
});
