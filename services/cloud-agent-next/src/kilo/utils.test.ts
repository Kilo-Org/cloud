import { describe, expect, it } from 'vitest';
import { extractUlid } from './utils.js';

describe('extractUlid', () => {
  it('extracts ulid portion from exc_ id', () => {
    expect(extractUlid('exc_123-456-789')).toBe('123-456-789');
    expect(extractUlid('exc_abc')).toBe('abc');
  });
});
