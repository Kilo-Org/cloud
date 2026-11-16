import { describe, expect, it } from 'vitest';
import { tokenEnvironment } from './token-environment.js';

describe('tokenEnvironment', () => {
  it('resolves an empty env to production', () => {
    expect(tokenEnvironment({})).toBe('production');
  });

  it('resolves an explicit undefined to production', () => {
    expect(tokenEnvironment({ ENVIRONMENT: undefined })).toBe('production');
  });

  it('resolves an empty string to production', () => {
    expect(tokenEnvironment({ ENVIRONMENT: '' })).toBe('production');
  });

  it('resolves production to production', () => {
    expect(tokenEnvironment({ ENVIRONMENT: 'production' })).toBe('production');
  });

  it('resolves development to development', () => {
    expect(tokenEnvironment({ ENVIRONMENT: 'development' })).toBe('development');
  });

  it('is case-sensitive, so a capitalized value stays production', () => {
    expect(tokenEnvironment({ ENVIRONMENT: 'Development' })).toBe('production');
  });

  it('resolves an unknown environment to production', () => {
    expect(tokenEnvironment({ ENVIRONMENT: 'staging' })).toBe('production');
  });
});
