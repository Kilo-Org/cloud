import { describe, expect, test } from '@jest/globals';
import { sanitizeJsonbValue, sanitizePostgresString } from './sanitize-jsonb';

describe('sanitizePostgresString', () => {
  test('replaces NUL characters and lone surrogates without changing valid text', () => {
    expect(sanitizePostgresString('before\0after\ud800')).toBe('before\ufffdafter\ufffd');
    expect(sanitizePostgresString('`\\u0000` 😀')).toBe('`\\u0000` 😀');
  });
});

describe('sanitizeJsonbValue', () => {
  test('replaces JSONB-incompatible characters in nested values and object keys', () => {
    const value = {
      [`bad\ud800key`]: ['before\udc00after', { text: 'still\ud800broken' }],
      [`nul\0key`]: 'nul\0value',
    };

    expect(sanitizeJsonbValue(value)).toEqual({
      ['bad\ufffdkey']: ['before\ufffdafter', { text: 'still\ufffdbroken' }],
      ['nul\ufffdkey']: 'nul\ufffdvalue',
    });
  });

  test('preserves valid surrogate pairs and does not mutate the input', () => {
    const value = { text: 'hello 😀' };

    const sanitized = sanitizeJsonbValue(value);

    expect(sanitized).toEqual(value);
    expect(sanitized).not.toBe(value);
  });
});
