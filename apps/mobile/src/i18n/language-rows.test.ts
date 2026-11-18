import { describe, expect, it } from 'vitest';

import { languagePickerItems, languageRows } from './language-rows';
import { SUPPORTED_LANGUAGES } from './languages';

describe('languageRows', () => {
  it('lists every supported language when the query is empty', () => {
    expect(languageRows('')).toHaveLength(SUPPORTED_LANGUAGES.length);
  });

  it('sorts by endonym', () => {
    const endonyms = languageRows('').map(row => row.endonym);
    expect(endonyms.toSorted((a, b) => a.localeCompare(b))).toEqual(endonyms);
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

describe('languagePickerItems', () => {
  it('opens on the current group, then every language', () => {
    const items = languagePickerItems('', 'zu', false);
    expect(items.slice(0, 4).map(item => item.key)).toEqual([
      'section:current',
      'device',
      'zu',
      'section:all',
    ]);
  });

  it('does not repeat the pinned language in the full list', () => {
    const items = languagePickerItems('', 'zu', false);
    expect(items.filter(item => item.key === 'zu')).toHaveLength(1);
    expect(items.filter(item => item.kind === 'language')).toHaveLength(SUPPORTED_LANGUAGES.length);
  });

  it('pins nothing extra when the preference is the device language', () => {
    const items = languagePickerItems('', 'zu', true);
    expect(items.slice(0, 3).map(item => item.key)).toEqual([
      'section:current',
      'device',
      'section:all',
    ]);
    expect(items.filter(item => item.kind === 'language')).toHaveLength(SUPPORTED_LANGUAGES.length);
  });

  it('drops the groups while a query is active', () => {
    const items = languagePickerItems('german', 'zu', false);
    expect(items.every(item => item.kind === 'language')).toBe(true);
    expect(items.map(item => item.key)).toContain('de');
  });
});
