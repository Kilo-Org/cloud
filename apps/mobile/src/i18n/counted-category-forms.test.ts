import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

const i18n = createInstance();
await i18n.init({
  resources: Object.fromEntries(
    SUPPORTED_LANGUAGES.map(tag => [tag, { translation: CATALOG_LOADERS[tag]() }])
  ),
  lng: 'en',
  fallbackLng: 'en',
  compatibilityJSON: 'v4',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

/**
 * The counts these assertions render. The set reaches past the small numbers a
 * plural rule treats specially: 21, 31 and 1001 select a language's singular
 * form in Serbian, Croatian, Bosnian, Russian, Ukrainian, Belarusian,
 * Macedonian, Lithuanian, Latvian, Icelandic and Filipino, and Slovene selects
 * it at 101 as well.
 */
const SAMPLE_COUNTS = [
  0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 21, 22, 25, 31, 100, 101, 111, 1001, 10_001, 1_000_000,
] as const;

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const COUNT_TOKEN = /\{\{\s*(?:displayCount|count)\s*\}\}/;
const DIGIT = /\p{Nd}/u;

/** Every plural family of one catalog, keyed by family name and then category. */
function pluralFamilies(
  value: unknown,
  prefix = '',
  found = new Map<string, Map<string, string>>()
): Map<string, Map<string, string>> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      pluralFamilies(child, path, found);
    } else {
      const match = PLURAL_SUFFIX.exec(path);
      const category = match?.[1];
      if (match && category && typeof child === 'string') {
        const family = path.slice(0, -match[0].length);
        const forms = found.get(family) ?? new Map<string, string>();
        forms.set(category, child);
        found.set(family, forms);
      }
    }
  }
  return found;
}

/** The thread's comment total as the discussion card renders it. */
function threadTotal(language: SupportedLanguage, count: number): string {
  return i18n.t('prReview.discussion.comment', {
    lng: language,
    count,
    displayCount: String(count),
  });
}

/**
 * The counts past 1 whose plural category is `one`. Those forms carry the
 * number itself, so a catalog that spells a single figure in `_one` renders
 * that figure at 21 and 101 as well.
 */
function otherCountsInSingularForm(language: SupportedLanguage): number[] {
  const rules = new Intl.PluralRules(language);
  return SAMPLE_COUNTS.filter(count => count > 1 && rules.select(count) === 'one');
}

/**
 * The forms of one catalog that spell a number their own plural rules can
 * select past 1, while a sibling category of the same family interpolates it.
 */
function spelledCounts(language: SupportedLanguage): string[] {
  const rules = new Intl.PluralRules(language);
  const spelled: string[] = [];
  for (const [family, forms] of pluralFamilies(CATALOG_LOADERS[language]())) {
    const interpolates = [...forms.values()].some(value => COUNT_TOKEN.test(value));
    for (const [category, value] of forms) {
      const spells = interpolates && !COUNT_TOKEN.test(value) && DIGIT.test(value);
      const count = spells
        ? SAMPLE_COUNTS.find(candidate => candidate > 1 && rules.select(candidate) === category)
        : undefined;
      if (count !== undefined) {
        spelled.push(`${language} ${family}_${category} at ${count}`);
      }
    }
  }
  return spelled;
}

const SINGULAR_ALSO_COUNTS = SUPPORTED_LANGUAGES.filter(
  language => otherCountsInSingularForm(language).length > 0
);

describe('plural forms that carry the count', () => {
  it('covers the languages whose singular form takes counts past 1', () => {
    expect(SINGULAR_ALSO_COUNTS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(SINGULAR_ALSO_COUNTS)('renders the thread total of %s at those counts', language => {
    for (const count of otherCountsInSingularForm(language)) {
      expect(threadTotal(language, count), `${language} ${count}`).toContain(String(count));
    }
  });

  it('renders each Serbian category with the count it was given', () => {
    expect(threadTotal('sr', 1)).toBe('1 komentar');
    expect(threadTotal('sr', 2)).toBe('2 komentara');
    expect(threadTotal('sr', 5)).toBe('5 komentara');
    expect(threadTotal('sr', 21)).toBe('21 komentar');
    expect(threadTotal('sr', 31)).toBe('31 komentar');
    expect(threadTotal('sr', 101)).toBe('101 komentar');
    expect(threadTotal('sr', 111)).toBe('111 komentara');
  });

  it('interpolates the count in every form a count past 1 selects', () => {
    expect(SUPPORTED_LANGUAGES.flatMap(language => spelledCounts(language))).toEqual([]);
  });
});
