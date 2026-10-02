import { describe, it, expect } from '@jest/globals';
import { isDataCollectionExplicitlyDisallowed } from './types';

describe('isDataCollectionExplicitlyDisallowed', () => {
  it('returns false when no provider config is given', () => {
    expect(isDataCollectionExplicitlyDisallowed(undefined)).toBe(false);
  });

  it('returns false for an empty provider config', () => {
    expect(isDataCollectionExplicitlyDisallowed({})).toBe(false);
  });

  it('returns false when data collection is explicitly allowed', () => {
    expect(isDataCollectionExplicitlyDisallowed({ data_collection: 'allow' })).toBe(false);
  });

  it('returns true when data collection is denied', () => {
    expect(isDataCollectionExplicitlyDisallowed({ data_collection: 'deny' })).toBe(true);
  });

  it('returns true when zero data retention is requested', () => {
    expect(isDataCollectionExplicitlyDisallowed({ zdr: true })).toBe(true);
  });

  it('returns false when zero data retention is explicitly disabled', () => {
    expect(isDataCollectionExplicitlyDisallowed({ zdr: false })).toBe(false);
  });

  it('returns true when zdr is set even though data collection is allowed', () => {
    expect(isDataCollectionExplicitlyDisallowed({ data_collection: 'allow', zdr: true })).toBe(
      true
    );
  });
});
