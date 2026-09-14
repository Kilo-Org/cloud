import { describe, expect, it, vi } from 'vitest';

import { foldForSearch } from './fold-for-search';

describe('foldForSearch', () => {
  it('strips diacritics and folds case', () => {
    expect(foldForSearch('Türkçe')).toBe('turkce');
    expect(foldForSearch('Español')).toBe('espanol');
  });

  it('folds case without consulting the device locale', () => {
    // A tr/az device lowers 'I' to 'ı', so a locale-sensitive fold would make
    // a search for "indonesian" miss "Indonesian". The fold must not use the
    // device locale.
    const toLocaleLowerCase = vi
      .spyOn(String.prototype, 'toLocaleLowerCase')
      .mockImplementation(() => 'ındonesıan');
    try {
      expect(foldForSearch('Indonesian')).toBe('indonesian');
    } finally {
      toLocaleLowerCase.mockRestore();
    }
  });
});
