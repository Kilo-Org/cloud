import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { computeDatabaseUrl, getDatabaseClientConfig } from './database-url';

const originalCa = process.env.DATABASE_CA;
const originalEnv = { ...process.env };

afterEach(() => {
  if (originalCa === undefined) {
    delete process.env.DATABASE_CA;
  } else {
    process.env.DATABASE_CA = originalCa;
  }
  process.env.NODE_ENV = originalEnv.NODE_ENV;
  process.env.JEST_WORKER_ID = originalEnv.JEST_WORKER_ID;
  process.env.POSTGRES_URL = originalEnv.POSTGRES_URL;
});

describe('computeDatabaseUrl', () => {
  it('appends the jest worker id to the database name, not the query string', () => {
    process.env.NODE_ENV = 'test';
    process.env.JEST_WORKER_ID = '3';
    process.env.POSTGRES_URL = 'postgres://user:secret@db.example.com:5432/mydb?sslmode=require';

    expect(computeDatabaseUrl()).toBe(
      'postgres://user:secret@db.example.com:5432/mydb-3?sslmode=require'
    );
  });

  it('returns the configured URL untouched outside test runs', () => {
    process.env.NODE_ENV = 'development';
    process.env.POSTGRES_URL = 'postgres://user:secret@db.example.com:5432/mydb?sslmode=require';

    expect(computeDatabaseUrl()).toBe(
      'postgres://user:secret@db.example.com:5432/mydb?sslmode=require'
    );
  });
});

describe('getDatabaseClientConfig', () => {
  describe('ssl derivation without DATABASE_CA', () => {
    beforeEach(() => {
      delete process.env.DATABASE_CA;
    });

    it('keeps TLS off when the URL carries no sslmode', () => {
      const config = getDatabaseClientConfig('postgres://user:secret@db.example.com:5432/mydb');

      expect(config.ssl).toBe(false);
    });

    it('encrypts without a certificate check for sslmode=require', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=require'
      );

      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('encrypts without a certificate check for sslmode=prefer', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=prefer'
      );

      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('verifies the certificate against the system trust store for sslmode=verify-full', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=verify-full'
      );

      expect(config.ssl).toEqual({ rejectUnauthorized: true });
    });

    it('verifies the certificate for sslmode=verify-ca', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=verify-ca'
      );

      expect(config.ssl).toEqual({ rejectUnauthorized: true });
    });

    it('keeps TLS off for sslmode=disable', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=disable'
      );

      expect(config.ssl).toBe(false);
    });

    it('keeps TLS off for sslmode=allow because pg cannot negotiate an upgrade', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=allow'
      );

      expect(config.ssl).toBe(false);
    });

    it('does not treat Object.prototype keys as modes', () => {
      expect(() =>
        getDatabaseClientConfig(
          'postgres://user:secret@db.example.com:5432/mydb?sslmode=constructor'
        )
      ).toThrow(/Unsupported sslmode/);
    });

    it('matches sslmode values case-insensitively and trims whitespace', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=REQUIRE'
      );

      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('fails startup on an unrecognized sslmode instead of guessing', () => {
      expect(() =>
        getDatabaseClientConfig(
          'postgres://user:secret@db.example.com:5432/mydb?sslmode=re escalat'
        )
      ).toThrow(/Unsupported sslmode/);
    });

    it('preserves credentials and host parts alongside the ssl decision', () => {
      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=require'
      );

      expect(config).toMatchObject({
        user: 'user',
        password: 'secret',
        host: 'db.example.com',
        port: 5432,
        database: 'mydb',
      });
    });
  });

  describe('with DATABASE_CA set', () => {
    const pem = '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----';

    it('prefers the configured CA over any URL sslmode', () => {
      process.env.DATABASE_CA = pem;

      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=require'
      );

      expect(config.ssl).toEqual({
        ca: pem.replace(/\\n/g, '\n'),
        rejectUnauthorized: true,
        servername: 'db.example.com',
      });
    });

    it('prefers the configured CA even when the URL disables TLS', () => {
      process.env.DATABASE_CA = pem;

      const config = getDatabaseClientConfig(
        'postgres://user:secret@db.example.com:5432/mydb?sslmode=disable'
      );

      expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
    });

    it('expands escaped newlines in the CA', () => {
      process.env.DATABASE_CA = pem;

      const config = getDatabaseClientConfig('postgres://user:secret@db.example.com:5432/mydb');

      expect(config.ssl).toMatchObject({ ca: pem.replace(/\\n/g, '\n') });
    });
  });
});
