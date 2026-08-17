import {
  MAX_POOL_CONNECTIONS,
  parseDataExportDatabaseUrl,
  QUERY_TIMEOUT_MS,
  resolveSslConfig,
} from './db';

describe('parseDataExportDatabaseUrl', () => {
  it('accepts a postgres URL', () => {
    expect(parseDataExportDatabaseUrl('postgresql://u:p@localhost:5432/data_export')).toEqual({
      ok: true,
      url: 'postgresql://u:p@localhost:5432/data_export',
    });
  });

  it('reports an unset variable separately from a malformed one', () => {
    expect(parseDataExportDatabaseUrl(undefined)).toEqual({ ok: false, reason: 'unset' });
    expect(parseDataExportDatabaseUrl('')).toEqual({ ok: false, reason: 'unset' });
  });

  it.each([
    ['missing port', 'postgresql://u:p@localhost/data_export'],
    ['wrong scheme', 'https://u:p@localhost:5432/data_export'],
    ['not a URL', 'localhost:5432'],
  ])('rejects %s', (_label, value) => {
    expect(parseDataExportDatabaseUrl(value)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('resolveSslConfig', () => {
  const originalCa = process.env.DATABASE_CA;
  const originalExportCa = process.env.DATA_EXPORT_DATABASE_CA;

  // Assigning undefined to process.env stores the truthy string 'undefined', which
  // would leak into every other test file sharing this Jest worker and give their
  // drizzle pools a bogus PEM CA. Delete the key instead.
  function restore(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    restore('DATABASE_CA', originalCa);
    restore('DATA_EXPORT_DATABASE_CA', originalExportCa);
  });

  it('disables TLS only for local hosts', () => {
    expect(resolveSslConfig('localhost')).toBe(false);
    expect(resolveSslConfig('127.0.0.1')).toBe(false);
  });

  it('treats a bracketed IPv6 loopback as local', () => {
    // new URL('postgresql://u:p@[::1]:5432/db').hostname === '[::1]'
    expect(resolveSslConfig(new URL('postgresql://u:p@[::1]:5432/db').hostname)).toBe(false);
    expect(resolveSslConfig('::1')).toBe(false);
  });

  it('requires TLS for remote hosts even with no CA configured', () => {
    delete process.env.DATABASE_CA;
    delete process.env.DATA_EXPORT_DATABASE_CA;

    // The failure mode that matters: a missing CA must not silently downgrade a
    // remote connection to plaintext.
    expect(resolveSslConfig('aws-0-eu-central-1.pooler.supabase.com')).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('prefers an export specific CA over the primary CA', () => {
    process.env.DATABASE_CA = 'primary-ca';
    process.env.DATA_EXPORT_DATABASE_CA = 'export-ca';

    expect(resolveSslConfig('db.example.supabase.co')).toEqual({
      ca: 'export-ca',
      rejectUnauthorized: true,
      servername: 'db.example.supabase.co',
    });
  });

  it('expands escaped newlines in a PEM CA', () => {
    delete process.env.DATA_EXPORT_DATABASE_CA;
    process.env.DATABASE_CA = '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----';

    const ssl = resolveSslConfig('db.example.supabase.co');
    expect(ssl).toMatchObject({
      ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    });
  });
});

describe('pool sizing', () => {
  it('does not inherit the primary request-path query timeout', () => {
    // POSTGRES_MAX_QUERY_TIME is 5000 under .env.test and is sized for interactive
    // queries; bulk export scans need their own budget.
    expect(QUERY_TIMEOUT_MS).toBe(60_000);
    expect(QUERY_TIMEOUT_MS).toBeGreaterThan(
      Number.parseInt(process.env.POSTGRES_MAX_QUERY_TIME || '20000')
    );
  });

  it('keeps the pool small so it does not contend with the primary', () => {
    expect(MAX_POOL_CONNECTIONS).toBe(3);
  });
});
