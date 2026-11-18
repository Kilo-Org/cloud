import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from '@/i18n/catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n/languages';

import { dateTimeFormat } from './intl-cache';

/**
 * Every Intl surface must write in the same alphabet as the catalog beside it.
 *
 * A bare language tag can resolve to a script the catalog does not use: `sr`
 * resolves to Cyrillic while the Serbian catalog is written in Latin, so a
 * user read Latin copy beside a Cyrillic month name. `intl-cache` names the
 * script for those tags; this test is what keeps the two in step.
 */

const SCRIPT_PATTERNS: Readonly<Record<string, RegExp>> = {
  Latin: /\p{Script=Latin}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
  Arabic: /\p{Script=Arabic}/u,
  Greek: /\p{Script=Greek}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Devanagari: /\p{Script=Devanagari}/u,
  Han: /\p{Script=Han}/u,
  Hangul: /\p{Script=Hangul}/u,
  Hiragana: /\p{Script=Hiragana}/u,
  Katakana: /\p{Script=Katakana}/u,
  Thai: /\p{Script=Thai}/u,
  Armenian: /\p{Script=Armenian}/u,
  Georgian: /\p{Script=Georgian}/u,
  Bengali: /\p{Script=Bengali}/u,
  Tamil: /\p{Script=Tamil}/u,
  Telugu: /\p{Script=Telugu}/u,
  Gujarati: /\p{Script=Gujarati}/u,
  Gurmukhi: /\p{Script=Gurmukhi}/u,
  Kannada: /\p{Script=Kannada}/u,
  Malayalam: /\p{Script=Malayalam}/u,
  Oriya: /\p{Script=Oriya}/u,
  Sinhala: /\p{Script=Sinhala}/u,
  Myanmar: /\p{Script=Myanmar}/u,
  Khmer: /\p{Script=Khmer}/u,
  Lao: /\p{Script=Lao}/u,
  Ethiopic: /\p{Script=Ethiopic}/u,
};

function scriptsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const char of text) {
    for (const [name, pattern] of Object.entries(SCRIPT_PATTERNS)) {
      if (pattern.test(char)) {
        found.add(name);
        break;
      }
    }
  }
  return found;
}

type CatalogNode = { [key: string]: CatalogNode | string };

function catalogScripts(language: SupportedLanguage): Set<string> {
  const values: string[] = [];
  const walk = (node: CatalogNode): void => {
    for (const child of Object.values(node)) {
      if (typeof child === 'string') {
        values.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(CATALOG_LOADERS[language]() as CatalogNode);
  return scriptsIn(values.join(' '));
}

// A calendar month is the shortest Intl output that is written in words, so it
// exposes the resolved script without depending on any one language's grammar.
const MARCH = new Date(Date.UTC(2026, 2, 14));

describe('Intl script agreement', () => {
  it.each(SUPPORTED_LANGUAGES)('formats %s in the catalog own script', language => {
    const monthName = dateTimeFormat(language, { month: 'long' }).format(MARCH);
    const monthScripts = scriptsIn(monthName);
    // A numeric month name (some locales) carries no script to compare.
    if (monthScripts.size === 0) {
      return;
    }
    const allowed = catalogScripts(language);
    // Latin rides along in every catalog for product names, so it can never
    // stand in for the catalog's own script.
    const catalogOwn = new Set([...allowed].filter(name => name !== 'Latin'));
    const expected = catalogOwn.size > 0 ? catalogOwn : new Set(['Latin']);
    for (const script of monthScripts) {
      expect(expected.has(script), `${language}: month "${monthName}" is ${script}`).toBe(true);
    }
  });
});
