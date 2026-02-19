import { describe, it, expect } from 'vitest';
import { FlyApiError, isFlyNotFound, isFlyInsufficientResources } from './client';

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

describe('isFlyInsufficientResources', () => {
  it('returns true for FlyApiError with status 412', () => {
    const err = new FlyApiError('insufficient resources', 412, '{}');
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('returns false for FlyApiError with non-412 status', () => {
    expect(isFlyInsufficientResources(new FlyApiError('not found', 404, '{}'))).toBe(false);
    expect(isFlyInsufficientResources(new FlyApiError('server error', 500, '{}'))).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isFlyInsufficientResources(new Error('something'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFlyInsufficientResources('string')).toBe(false);
    expect(isFlyInsufficientResources(null)).toBe(false);
    expect(isFlyInsufficientResources(undefined)).toBe(false);
  });
});
