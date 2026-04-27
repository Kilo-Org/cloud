import { describe, expect, it } from 'vitest';
import { isValidTimezone, parseEnableArgs } from './enable-input-utils';

describe('enable-input-utils', () => {
  it('parses simple command args with cron only', () => {
    expect(parseEnableArgs('0 7 * * *')).toEqual({ cron: '0 7 * * *' });
  });

  it('parses command args with cron and timezone', () => {
    expect(parseEnableArgs('0 7 * * * America/Chicago')).toEqual({
      cron: '0 7 * * *',
      timezone: 'America/Chicago',
    });
  });

  it('keeps timezone intact when it has spaces', () => {
    expect(parseEnableArgs('0 7 * * * America/Argentina/Buenos_Aires')).toEqual({
      cron: '0 7 * * *',
      timezone: 'America/Argentina/Buenos_Aires',
    });
  });

  it('returns empty object for blank input', () => {
    expect(parseEnableArgs('')).toEqual({});
  });

  it('validates IANA timezone names', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('America/Chcago')).toBe(false);
  });
});
