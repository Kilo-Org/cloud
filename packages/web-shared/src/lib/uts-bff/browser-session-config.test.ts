import { describe, expect, test } from '@jest/globals';
import {
  browserSessionCookieNames,
  browserSessionPepperBinding,
  cookieValues,
  isBrowserSessionBindingCurrent,
  utsBrowserSessionEnvironment,
} from './browser-session-config';

describe('utsBrowserSessionEnvironment', () => {
  test.each([
    [{}, null],
    [{ UTS_BROWSER_SESSIONS: 'true' }, null],
    [{ UTS_BROWSER_SESSIONS: 'on' }, 'development'],
    [{ UTS_BROWSER_SESSIONS: 'on', VERCEL: '1' }, null],
    [{ UTS_BROWSER_SESSIONS: 'on', VERCEL: '1', VERCEL_ENV: 'production' }, null],
    [
      { UTS_BROWSER_SESSIONS: 'on', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' },
      'production',
    ],
    [
      { UTS_BROWSER_SESSIONS: 'on', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' },
      'staging',
    ],
    [{ UTS_BROWSER_SESSIONS: 'on', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' }, null],
    [{ UTS_BROWSER_SESSIONS: 'on', VERCEL_ENV: 'development' }, 'development'],
    [
      { UTS_BROWSER_SESSIONS: 'on', VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' },
      'development',
    ],
    [{ UTS_BROWSER_SESSIONS: 'on', VERCEL: '1', VERCEL_ENV: 'development' }, null],
    [
      { UTS_BROWSER_SESSIONS: 'on', VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'production' },
      null,
    ],
    [{ UTS_BROWSER_SESSIONS: 'on', VERCEL_TARGET_ENV: 'staging' }, null],
    [{ VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' }, null],
  ])('%j serves %s', (runtime, expected) => {
    expect(utsBrowserSessionEnvironment(runtime)).toBe(expected);
  });
});

describe('browserSessionCookieNames', () => {
  test('deployed environments use __Host- cookies; local development does not', () => {
    expect(browserSessionCookieNames('production')).toEqual({
      session: '__Host-kilo-web-session',
      transaction: '__Host-kilo-web-tx',
    });
    expect(browserSessionCookieNames('staging').session).toBe('__Host-kilo-web-session');
    expect(browserSessionCookieNames('development')).toEqual({
      session: 'kilo-web-session',
      transaction: 'kilo-web-tx',
    });
  });
});

describe('cookieValues', () => {
  test('returns every value of the exact name only', () => {
    const header = 'a=1; kilo-web-session=x; __Host-kilo-web-session=y; kilo-web-session=z';
    expect(cookieValues(header, 'kilo-web-session')).toEqual(['x', 'z']);
    expect(cookieValues(null, 'kilo-web-session')).toEqual([]);
  });
});

describe('pepper binding', () => {
  test('binds to the pepper without revealing it, and to an absent pepper', () => {
    const binding = browserSessionPepperBinding('pepper-1');
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(binding).not.toContain('pepper-1');
    expect(isBrowserSessionBindingCurrent(binding, 'pepper-1')).toBe(true);
    expect(isBrowserSessionBindingCurrent(binding, 'pepper-2')).toBe(false);
    expect(isBrowserSessionBindingCurrent(binding, null)).toBe(false);
    expect(browserSessionPepperBinding(null)).toBe('none');
    expect(isBrowserSessionBindingCurrent('none', null)).toBe(true);
    expect(isBrowserSessionBindingCurrent('none', 'pepper-1')).toBe(false);
  });
});
