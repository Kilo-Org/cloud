import { describe, expect, it, vi } from 'vitest';

import { foldForSearch } from './fold-for-search';

// A call without a locale list follows the device locale, which the fold must
// never do; a pinned locale that keeps the ASCII result is fine.
const usesDeviceLocale = (locales: Intl.LocalesArgument | undefined): boolean =>
  locales === undefined || (Array.isArray(locales) && locales.length === 0);

describe('foldForSearch', () => {
  it('strips diacritics and folds case', () => {
    expect(foldForSearch('Türkçe')).toBe('turkce');
    expect(foldForSearch('Español')).toBe('espanol');
    expect(foldForSearch('Indonesian')).toBe('indonesian');
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

  it('folds case without an unpinned lowercase call', () => {
    // A tr/az device lowers 'I' to 'ı', so a locale-sensitive fold would make
    // a search for "indonesian" miss "Indonesian". The fold must not take the
    // device default: every locale-sensitive call has to name a locale. A
    // pinned locale such as 'en' still yields the ASCII 'i', so callers may
    // pin one. A fold that names the host locale itself cannot be told apart
    // from a deliberately pinned one where the host yields the ASCII result,
    // which is why this case asserts the call shape rather than the result
    // alone.
    const toLocaleLowerCase = vi.spyOn(String.prototype, 'toLocaleLowerCase');
    let folded = '';
    let deviceLocaleCalls = 0;
    try {
      folded = foldForSearch('Indonesian');
      deviceLocaleCalls = toLocaleLowerCase.mock.calls.filter(([locales]) =>
        usesDeviceLocale(locales)
      ).length;
    } finally {
      toLocaleLowerCase.mockRestore();
    }
    expect(folded).toBe('indonesian');
    expect(deviceLocaleCalls).toBe(0);
  });
});
