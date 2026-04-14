import { describe, it, expect } from 'vitest';
import { ulid } from '../lib/ulid';

describe('ulid', () => {
  it('returns a 26-character string', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
  });

  it('contains only Crockford base32 characters', () => {
    const id = ulid();
    expect(id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  it('is sortable by time', () => {
    const a = ulid();
    const b = ulid(Date.now() + 1000);
    expect(b > a).toBe(true);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => ulid()));
    expect(ids.size).toBe(100);
  });
});
