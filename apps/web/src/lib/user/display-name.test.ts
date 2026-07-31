import { describe, test, expect } from '@jest/globals';

import { resolveDisplayName } from '@/lib/user/display-name';

describe('resolveDisplayName', () => {
  test('returns google_user_name when no providers are present', () => {
    expect(resolveDisplayName([], 'Ada')).toBe('Ada');
  });

  test('returns google_user_name when every provider has a null display_name', () => {
    const providers = [{ display_name: null }, { display_name: null }];
    expect(resolveDisplayName(providers, 'Ada')).toBe('Ada');
  });

  test('returns the newest non-null provider display_name (providers ordered ASC)', () => {
    const providers = [{ display_name: 'Old' }, { display_name: null }, { display_name: 'New' }];
    expect(resolveDisplayName(providers, 'Ignored')).toBe('New');
  });

  test('a trailing null provider does not beat an older non-null one', () => {
    const providers = [{ display_name: 'Ada' }, { display_name: null }];
    expect(resolveDisplayName(providers, 'Fallback')).toBe('Ada');
  });

  test('empty-string provider display_name passes through; null google_user_name returns null', () => {
    expect(resolveDisplayName([{ display_name: '' }], 'Google')).toBe('');
    expect(resolveDisplayName([], null)).toBeNull();
  });
});
