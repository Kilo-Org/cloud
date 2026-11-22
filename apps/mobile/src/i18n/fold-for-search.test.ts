import { describe, expect, it, vi } from 'vitest';

import { foldForSearch } from './fold-for-search';

describe('foldForSearch', () => {
  it('strips diacritics and folds case', () => {
    expect(foldForSearch('Türkçe')).toBe('turkce');
    expect(foldForSearch('Español')).toBe('espanol');
  });

  it('folds compatibility forms to the plain letters they stand for', () => {
    // Full-width text arrives from a CJK input method or a paste, and the
    // stored names are ASCII or precomposed, so the fold must map it.
    expect(foldForSearch('ＥＳＰＡＮＯＬ')).toBe('espanol');
    expect(foldForSearch('Ｔürkçe')).toBe('turkce');
    expect(foldForSearch('１２３')).toBe('123');
    expect(foldForSearch('ﬁle')).toBe('file');
    expect(foldForSearch('Ａ１ ﬁ')).toBe('a1 fi');
  });

  it('folds a compatibility form the same way as the text it looks like', () => {
    expect(foldForSearch('ＥＳＰＡＮＯＬ')).toBe(foldForSearch('Español'));
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
