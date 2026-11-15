import { describe, expect, test } from '@jest/globals';

import { isMobileClient } from '@kilocode/web-shared/lib/app-headers';

describe('isMobileClient', () => {
  test('is false for an absent or non-mobile client', () => {
    expect(isMobileClient(undefined)).toBe(false);
    expect(isMobileClient(null)).toBe(false);
    expect(isMobileClient('web')).toBe(false);
    expect(isMobileClient('MOBILE')).toBe(false);
  });

  test('is true for the mobile client', () => {
    expect(isMobileClient('mobile')).toBe(true);
  });
});
