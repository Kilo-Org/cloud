import { describe, it, expect } from 'vitest';
import { FlyApiError, isFlyNotFound } from './client';

describe('isFlyNotFound', () => {
  it('returns true for FlyApiError with status 404', () => {
    const err = new FlyApiError('not found', 404, '{}');
    expect(isFlyNotFound(err)).toBe(true);
  });

  it('returns false for FlyApiError with non-404 status', () => {
    const err = new FlyApiError('server error', 500, '{}');
    expect(isFlyNotFound(err)).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isFlyNotFound(new Error('something'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFlyNotFound('string')).toBe(false);
    expect(isFlyNotFound(null)).toBe(false);
    expect(isFlyNotFound(undefined)).toBe(false);
    expect(isFlyNotFound(42)).toBe(false);
  });
});
