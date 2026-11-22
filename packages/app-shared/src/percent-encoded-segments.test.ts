import { describe, expect, it } from 'vitest';

import {
  decodePercentEncodedSegments,
  encodePercentEncodedSegments,
} from './percent-encoded-segments';

describe('encodePercentEncodedSegments (the decoder inverse)', () => {
  it.each([
    ['non-ASCII text', 'fix/請求書'],
    ['the encodeURI-literal ASCII characters', 'fix/a&b;c+d$e,f=g@h'],
    ['a literal % followed by digits that are not an escape', 'fix/100%20x%zz'],
    ['several segments', 'feature/deep/nested/branch'],
    ['mixed text, escapes and slashes', 'fix/請求書/a&b/100%/x'],
    ['an ASCII ref', 'fix/checkout-retries'],
    ['empty segments', 'fix//a&b/'],
  ])('round-trips %s through decode', (_label, value) => {
    expect(decodePercentEncodedSegments(encodePercentEncodedSegments(value))).toBe(value);
  });

  it('leaves a plain ASCII ref unchanged', () => {
    expect(encodePercentEncodedSegments('fix/checkout-retries')).toBe('fix/checkout-retries');
  });

  it('escapes the characters encodeURI leaves literal', () => {
    expect(encodePercentEncodedSegments('fix/a&b')).toBe('fix/a%26b');
    expect(encodePercentEncodedSegments('fix/a&b;c+d$e,f=g@h')).toBe(
      'fix/a%26b%3Bc%2Bd%24e%2Cf%3Dg%40h'
    );
  });

  it('keeps / a separator instead of escaping it', () => {
    const encoded = encodePercentEncodedSegments('fix/a&b/deep');
    expect(encoded).toBe('fix/a%26b/deep');
    expect(encoded.split('/')).toHaveLength(3);
  });

  it('keeps a lone surrogate raw instead of throwing', () => {
    expect(encodePercentEncodedSegments('\uD800')).toBe('\uD800');
    expect(encodePercentEncodedSegments('fix/\uD800/請求書')).toBe(
      'fix/\uD800/%E8%AB%8B%E6%B1%82%E6%9B%B8'
    );
  });
});
