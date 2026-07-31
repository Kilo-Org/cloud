import { describe, expect, test } from '@jest/globals';
import { sanitizeJsonbValue } from './sanitize-jsonb';

describe('sanitizeJsonbValue', () => {
  test('replaces lone surrogates in nested values and object keys', () => {
    const value = {
      [`bad\ud800key`]: ['before\udc00after', { text: 'still\ud800broken' }],
    };

    expect(sanitizeJsonbValue(value)).toEqual({
      ['bad\ufffdkey']: ['before\ufffdafter', { text: 'still\ufffdbroken' }],
    });
  });

  test('preserves valid surrogate pairs and does not mutate the input', () => {
    const value = { text: 'hello 😀' };

    const sanitized = sanitizeJsonbValue(value);

    expect(sanitized).toEqual(value);
    expect(sanitized).not.toBe(value);
  });
});
