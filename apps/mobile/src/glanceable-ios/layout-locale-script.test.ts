/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module, anti-slop/no-runtime-typeof -- this test reads the locale catalogs from disk, and JSON.parse returns unknown, which needs a runtime check */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import { resolveGlanceableLocale } from './layout-copy';

const LOCALES_DIR = join(__dirname, '..', 'i18n', 'locales');

/**
 * The scripts a supported catalog can be written in. `resolveGlanceableLocale`
 * only has to correct a language whose catalog script differs from the script
 * a bare tag makes SwiftUI pick. A Latin catalog is inferred when no other
 * script clears the noise floor, because every catalog carries Latin brand
 * names and placeholders.
 */
const CATALOG_SCRIPTS = [
  'Latin',
  'Cyrillic',
  'Greek',
  'Arabic',
  'Hebrew',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
  'Thai',
  'Lao',
  'Myanmar',
  'Khmer',
  'Georgian',
  'Armenian',
  'Ethiopic',
  'Tibetan',
] as const;

/** The CLDR script subtag for a catalog script, when they differ in spelling. */
const CLDR_SCRIPT_SUBTAG = {
  Latin: 'Latn',
  Cyrillic: 'Cyrl',
  Greek: 'Grek',
  Arabic: 'Arab',
  Hebrew: 'Hebr',
  Han: 'Hani',
  Hiragana: 'Jpan',
  Katakana: 'Jpan',
  Hangul: 'Kore',
  Devanagari: 'Deva',
  Bengali: 'Beng',
  Gurmukhi: 'Guru',
  Gujarati: 'Gujr',
  Oriya: 'Orya',
  Tamil: 'Taml',
  Telugu: 'Telu',
  Kannada: 'Knda',
  Malayalam: 'Mlym',
  Sinhala: 'Sinh',
  Thai: 'Thai',
  Lao: 'Laoo',
  Myanmar: 'Mymr',
  Khmer: 'Khmr',
  Georgian: 'Geor',
  Armenian: 'Armn',
  Ethiopic: 'Ethi',
  Tibetan: 'Tibt',
} satisfies Record<(typeof CATALOG_SCRIPTS)[number], string>;

const SCRIPT_MATCHERS = CATALOG_SCRIPTS.map(script => {
  try {
    return { script, pattern: new RegExp(`\\p{Script=${script}}`, 'u') };
  } catch {
    return null;
  }
}).filter(entry => entry !== null);

/** The fewest copies of a script before it counts as the catalog's script. */
const SCRIPT_NOISE_FLOOR = 20;

function collectStrings(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectStrings(item, out);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectStrings(value, out);
    }
  }
}

/** The script a catalog is written in, Latin unless another clears the floor. */
function catalogScript(tag: string): (typeof CATALOG_SCRIPTS)[number] {
  const parsed: unknown = JSON.parse(readFileSync(join(LOCALES_DIR, `${tag}.json`), 'utf8'));
  const strings: string[] = [];
  collectStrings(parsed, strings);
  const text = strings.join('\n').replaceAll(/\{\{[^}]*\}\}/g, ' ');

  const counts = new Map<string, number>();
  for (const character of text) {
    for (const { script, pattern } of SCRIPT_MATCHERS) {
      if (pattern.test(character)) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        break;
      }
    }
  }

  let dominant: (typeof CATALOG_SCRIPTS)[number] = 'Latin';
  let dominantCount = SCRIPT_NOISE_FLOOR - 1;
  for (const [script, count] of counts) {
    if (script !== 'Latin' && count > dominantCount && isCatalogScript(script)) {
      dominant = script;
      dominantCount = count;
    }
  }
  return dominant;
}

function isCatalogScript(script: string): script is (typeof CATALOG_SCRIPTS)[number] {
  return (CATALOG_SCRIPTS as readonly string[]).includes(script);
}

function cldrScriptForTag(tag: string): string {
  return new Intl.Locale(tag).maximize().script ?? '';
}

const SCRIPTLESS_LANGUAGES = SUPPORTED_LANGUAGES.filter(tag => !tag.includes('-'));

/**
 * The only supported language whose catalog script differs from the script a
 * bare tag makes SwiftUI pick. Verified against every catalog: Serbian ships a
 * Latin catalog while its tag defaults to Cyrillic. A new language that adds
 * this divergence fails the assertion and must be added to the map.
 */
const KNOWN_SCRIPT_DIVERGENCE = ['sr'];

describe('glanceable locale script', () => {
  it('names a script only for catalogs whose script differs from the tag default', () => {
    const divergent = SCRIPTLESS_LANGUAGES.filter(
      tag => CLDR_SCRIPT_SUBTAG[catalogScript(tag)] !== cldrScriptForTag(tag)
    );
    expect(divergent).toEqual(KNOWN_SCRIPT_DIVERGENCE);
  });

  it('keeps an explicit script subtag on a language that carries one', () => {
    for (const tag of SUPPORTED_LANGUAGES.filter(candidate => candidate.includes('-'))) {
      expect(resolveGlanceableLocale(tag)).toBe(tag.replace('-', '_'));
    }
  });

  it('resolves Serbian to the Latin script and English to itself', () => {
    expect(resolveGlanceableLocale('sr')).toBe('sr_Latn');
    expect(resolveGlanceableLocale('en')).toBe('en');
  });
});
