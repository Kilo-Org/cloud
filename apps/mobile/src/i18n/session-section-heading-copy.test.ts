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
 * The two counted families the shared session-list section header speaks with.
 * The visible row keeps the section title and a bare numeral apart, so the
 * heading label is the only string that ties the number to what it counts. Every
 * catalog has to say that in its own plural forms: a bare number after the title
 * is the defect these families replace.
 */
const FAMILIES = [
  'agents.sessionList.sectionAccessibility',
  'share.connectedCliAccessibility',
] as const;

/** Counts that reach several plural categories, including the zero and teen ranges. */
const COUNTS = [0, 1, 2, 3, 5, 11, 21, 101, 1000] as const;

const TITLE = 'TT';

function heading(
  family: (typeof FAMILIES)[number],
  language: SupportedLanguage,
  count: number
): string {
  return i18n.t(family, {
    lng: language,
    title: TITLE,
    count,
    displayCount: new Intl.NumberFormat(language).format(count),
  });
}

describe('session-list section heading copy', () => {
  it('names one session and several sessions in English', () => {
    expect(heading('agents.sessionList.sectionAccessibility', 'en', 1)).toBe('TT, 1 session');
    expect(heading('agents.sessionList.sectionAccessibility', 'en', 2)).toBe('TT, 2 sessions');
  });

  it('names one connected CLI and several in English', () => {
    expect(heading('share.connectedCliAccessibility', 'en', 1)).toBe('TT, 1 instance');
    expect(heading('share.connectedCliAccessibility', 'en', 3)).toBe('TT, 3 instances');
  });

  it.each([0, 1, 2, 3, 11, 100] as const)('uses its own Arabic plural form at %i', count => {
    const expected: Record<number, string> = {
      0: '{{title}}: {{displayCount}} جلسة',
      1: '{{title}}: {{displayCount}} جلسة واحدة',
      2: '{{title}}: {{displayCount}} جلستان',
      3: '{{title}}: {{displayCount}} جلسات',
      11: '{{title}}: {{displayCount}} جلسة',
      100: '{{title}}: {{displayCount}} جلسة',
    };
    const rendered = heading('agents.sessionList.sectionAccessibility', 'ar', count);
    expect(rendered).toBe(
      (expected[count] ?? '')
        .replace('{{title}}', TITLE)
        // The label carries the count the row shows: the `Intl.NumberFormat('ar')`
        // digits of this runtime, which render Latin digits here and on the
        // device (the emulator's header reads «اليوم: 2 جلستان»), not
        // Arabic-Indic digits.
        .replace('{{displayCount}}', new Intl.NumberFormat('ar').format(count))
    );
  });

  it.each(SUPPORTED_LANGUAGES)('%s states the title and the count in every family', language => {
    for (const family of FAMILIES) {
      for (const count of COUNTS) {
        const rendered = heading(family, language, count);
        expect(rendered, `${language} ${family} ${count}`).toContain(TITLE);
        expect(rendered, `${language} ${family} ${count}`).not.toBe(TITLE);
        // The count reaches the label as a numeral or as the word its own
        // singular or dual form uses; either way the label is more than the
        // title on its own.
        expect(rendered.length, `${language} ${family} ${count}`).toBeGreaterThan(TITLE.length + 1);
      }
    }
  });
});
