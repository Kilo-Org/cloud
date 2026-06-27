import { describe, expect, it } from '@jest/globals';
import { isCountryAllowed } from './country-access';

describe('isCountryAllowed', () => {
  it('allows all countries when the allow-list is absent', () => {
    expect(isCountryAllowed(undefined, 'US')).toBe(true);
    expect(isCountryAllowed(undefined, null)).toBe(true);
  });

  it('allows all countries when the allow-list is empty', () => {
    expect(isCountryAllowed([], 'US')).toBe(true);
    expect(isCountryAllowed([], null)).toBe(true);
  });

  it('allows a request whose country is in the allow-list', () => {
    expect(isCountryAllowed(['US', 'CA'], 'US')).toBe(true);
    expect(isCountryAllowed(['US', 'CA'], 'CA')).toBe(true);
  });

  it('denies a request whose country is not in the allow-list', () => {
    expect(isCountryAllowed(['US', 'CA'], 'GB')).toBe(false);
  });

  it('compares case-insensitively', () => {
    expect(isCountryAllowed(['us', 'ca'], 'US')).toBe(true);
    expect(isCountryAllowed(['US', 'CA'], 'ca')).toBe(true);
  });

  it('trims surrounding whitespace before comparing', () => {
    expect(isCountryAllowed([' US ', 'CA '], 'US')).toBe(true);
    expect(isCountryAllowed(['US'], '  us  ')).toBe(true);
  });

  it('fails closed when the request country cannot be determined', () => {
    expect(isCountryAllowed(['US'], null)).toBe(false);
    expect(isCountryAllowed(['US'], '')).toBe(false);
    expect(isCountryAllowed(['US'], '   ')).toBe(false);
  });
});
