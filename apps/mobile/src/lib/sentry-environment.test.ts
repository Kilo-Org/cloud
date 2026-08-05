import { describe, expect, it } from 'vitest';

import { resolveSentryEnvironment } from '@/lib/sentry-environment';

describe('resolveSentryEnvironment', () => {
  it('returns trimmed raw when non-empty and isDev is true', () => {
    expect(resolveSentryEnvironment('preview', true)).toBe('preview');
    expect(resolveSentryEnvironment(' preview ', true)).toBe('preview');
  });

  it('returns trimmed raw when non-empty and isDev is false', () => {
    expect(resolveSentryEnvironment('production', false)).toBe('production');
    expect(resolveSentryEnvironment(' preview ', false)).toBe('preview');
  });

  it('falls back to development when raw is undefined and isDev is true', () => {
    expect(resolveSentryEnvironment(undefined, true)).toBe('development');
  });

  it('falls back to unknown when raw is undefined and isDev is false', () => {
    expect(resolveSentryEnvironment(undefined, false)).toBe('unknown');
  });

  it('falls back to development for empty/whitespace raw when isDev is true', () => {
    expect(resolveSentryEnvironment('', true)).toBe('development');
    expect(resolveSentryEnvironment('   ', true)).toBe('development');
  });

  it('falls back to unknown for empty/whitespace raw when isDev is false', () => {
    expect(resolveSentryEnvironment('', false)).toBe('unknown');
    expect(resolveSentryEnvironment('   ', false)).toBe('unknown');
  });

  it('always returns a string (never undefined)', () => {
    const cases: [string | undefined, boolean][] = [
      [undefined, true],
      [undefined, false],
      ['', true],
      ['', false],
      ['   ', true],
      ['   ', false],
      ['preview', true],
      ['preview', false],
      [' production ', false],
    ];

    for (const [raw, isDev] of cases) {
      const result = resolveSentryEnvironment(raw, isDev);
      expect(typeof result).toBe('string');
      expect(result).not.toBe('');
    }
  });
});
