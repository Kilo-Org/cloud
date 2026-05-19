import { describe, expect, it } from 'vitest';
import { extractUlid, shellQuote } from './utils.js';

describe('extractUlid', () => {
  it('extracts ulid portion from exc_ id', () => {
    expect(extractUlid('exc_123-456-789')).toBe('123-456-789');
    expect(extractUlid('exc_abc')).toBe('abc');
  });
});

describe('shellQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('handles string with multiple single quotes', () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});
