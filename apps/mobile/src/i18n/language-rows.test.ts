import { describe, expect, it } from 'vitest';

import { languageRows } from './language-rows';
import { SUPPORTED_LANGUAGES } from './languages';

describe('languageRows', () => {
  it('lists every supported language when the query is empty', () => {
    expect(languageRows('')).toHaveLength(SUPPORTED_LANGUAGES.length);
  });

  it('sorts by endonym', () => {
    const endonyms = languageRows('').map(row => row.endonym);
    expect(endonyms.toSorted((a, b) => a.localeCompare(b))).toEqual(endonyms);
  });

  it('pins the active language first', () => {
    expect(languageRows('', 'zu')[0]?.tag).toBe('zu');
  });

  it('matches the endonym without diacritics', () => {
    expect(languageRows('espanol').map(row => row.tag)).toContain('es');
    expect(languageRows('turkce').map(row => row.tag)).toContain('tr');
  });

  it('matches the English name and the tag', () => {
    expect(languageRows('german').map(row => row.tag)).toContain('de');
    expect(languageRows('zh-Hant').map(row => row.tag)).toContain('zh-Hant');
  });

  it('returns nothing when the query matches no language', () => {
    expect(languageRows('klingon')).toHaveLength(0);
  });
});
