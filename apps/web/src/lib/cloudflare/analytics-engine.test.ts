import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as z from 'zod';
import { queryAnalyticsEngine, sqlDateTime, sqlString } from '@/lib/cloudflare/analytics-engine';

const RowSchema = z.object({ model: z.string(), requests: z.coerce.number() });
const originalEnv = { ...process.env };

describe('queryAnalyticsEngine', () => {
  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = 'account-id';
    process.env.CF_ANALYTICS_ENGINE_TOKEN = 'ae-token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('posts the SQL and parses each row with the given schema', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json({ data: [{ model: 'openai/gpt-6.1-sol', requests: '42' }], rows: 1 })
      );

    const rows = await queryAnalyticsEngine('SELECT 1 FORMAT JSON', RowSchema, {
      timeoutMs: 1000,
    });

    expect(rows).toEqual([{ model: 'openai/gpt-6.1-sol', requests: 42 }]);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-id/analytics_engine/sql'
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer ae-token' },
      body: 'SELECT 1 FORMAT JSON',
    });
  });

  it('rejects rows that do not match the schema', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ data: [{ model: 1 }] }));

    await expect(
      queryAnalyticsEngine('SELECT 1 FORMAT JSON', RowSchema, { timeoutMs: 1000 })
    ).rejects.toThrow();
  });

  it('includes the status and body when the query fails', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('syntax error', { status: 422 }));

    await expect(queryAnalyticsEngine('SELEC', RowSchema, { timeoutMs: 1000 })).rejects.toThrow(
      'Analytics Engine query failed (422): syntax error'
    );
  });

  it('fails without calling the API when configuration is missing', async () => {
    delete process.env.CF_ANALYTICS_ENGINE_TOKEN;
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(
      queryAnalyticsEngine('SELECT 1 FORMAT JSON', RowSchema, { timeoutMs: 1000 })
    ).rejects.toThrow('Missing Cloudflare Analytics Engine configuration');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('SQL helpers', () => {
  it('escapes single quotes in string literals', () => {
    expect(sqlString("vendor/o'model")).toBe("'vendor/o''model'");
  });

  it('escapes quotes and backslashes into one literal per value', () => {
    const cases: Array<[value: string, literal: string]> = [
      ['', "''"],
      ['openai/gpt-6.1-sol', "'openai/gpt-6.1-sol'"],
      ["vendor/o'model", "'vendor/o''model'"],
      ['a\\b', "'a\\\\b'"],
      ['\\', "'\\\\'"],
      ['a\\', "'a\\\\'"],
      ["a\\'b", "'a\\\\''b'"],
      ["\\''", "'\\\\'''''"],
    ];

    for (const [value, literal] of cases) {
      expect(sqlString(value)).toBe(literal);
    }
  });

  it('encodes control characters as hex escapes', () => {
    expect(sqlString('a\nb\tc\u0000d\u007fe')).toBe("'a\\x0ab\\x09c\\x00d\\x7fe'");
  });

  it('leaves printable non-ASCII text unchanged', () => {
    expect(sqlString('モデル/λ')).toBe("'モデル/λ'");
  });

  it('formats milliseconds as a whole-second DateTime', () => {
    expect(sqlDateTime(Date.parse('2026-10-02T12:00:00.999Z'))).toBe('toDateTime(1790942400)');
  });
});
