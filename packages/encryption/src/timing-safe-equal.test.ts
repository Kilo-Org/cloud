import { describe, test, expect } from 'vitest';
import { timingSafeEqual } from './timing-safe-equal.js';

describe('timingSafeEqual', () => {
  test('returns true for identical strings', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true);
  });

  test('returns true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  test('returns false for different strings of same length', () => {
    expect(timingSafeEqual('hello', 'world')).toBe(false);
  });

  test('returns false for strings of different lengths', () => {
    expect(timingSafeEqual('short', 'longer string')).toBe(false);
  });

  test('returns false when first string is longer', () => {
    expect(timingSafeEqual('longer string', 'short')).toBe(false);
  });

  test('detects single-character difference', () => {
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
  });

  test('handles unicode strings', () => {
    expect(timingSafeEqual('héllo wörld', 'héllo wörld')).toBe(true);
    expect(timingSafeEqual('héllo wörld', 'hello world')).toBe(false);
  });

  test('handles token-like strings', () => {
    const token = 'tok_abc123def456ghi789jkl012mno345pqr';
    expect(timingSafeEqual(token, token)).toBe(true);
    expect(timingSafeEqual(token, token.slice(0, -1) + 'x')).toBe(false);
  });
});
