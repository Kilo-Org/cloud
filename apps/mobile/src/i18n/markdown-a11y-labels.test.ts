import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';

const i18n = createInstance();
await i18n.init({
  resources: Object.fromEntries(
    SUPPORTED_LANGUAGES.map(tag => [tag, { translation: CATALOG_LOADERS[tag]() }])
  ),
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

/** The eleven screen-reader labels the markdown renderer accepts. */
const KEYS = [
  'list.bulletPoint',
  'list.nestedBulletPoint',
  'list.orderedItem',
  'list.nestedOrderedItem',
  'blockquote.quote',
  'blockquote.nestedQuote',
  'table.row',
  'math.equation',
  'rotor.headings',
  'rotor.links',
  'rotor.images',
] as const;

/**
 * The single-brace placeholders the renderer substitutes at speak time. They
 * are not i18next `{{…}}` templates, so a catalog must carry them verbatim.
 */
const EXPECTED_TOKENS: Record<(typeof KEYS)[number], string[]> = {
  'list.bulletPoint': [],
  'list.nestedBulletPoint': [],
  'list.orderedItem': ['{n}'],
  'list.nestedOrderedItem': ['{n}'],
  'blockquote.quote': [],
  'blockquote.nestedQuote': [],
  'table.row': ['{content}', '{n}'],
  'math.equation': ['{latex}'],
  'rotor.headings': [],
  'rotor.links': [],
  'rotor.images': [],
};

function tokens(text: string): string[] {
  return [...text.matchAll(/\{[a-zA-Z]+\}/g)].map(match => match[0]).sort();
}

/** The label one language renders, after falling back to English. */
function label(language: string, key: (typeof KEYS)[number]): string {
  return i18n.getFixedT(language)(`common.markdownA11y.${key}`);
}

describe('markdown accessibility labels', () => {
  it('keeps the renderer placeholders in every language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of KEYS) {
        expect(tokens(label(language, key)), `${language} ${key}`).toStrictEqual(
          EXPECTED_TOKENS[key]
        );
      }
    }
  });

  it('leaves a single-brace table row template intact for i18next', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const row = i18n.getFixedT(language)('common.markdownA11y.table.row');
      expect(row, `${language} table.row {n}`).toContain('{n}');
      expect(row, `${language} table.row {content}`).toContain('{content}');
    }
  });
});
