/* eslint-disable import/no-nodejs-modules -- vitest-only guard, reads the locale directory under Node, never bundled into the app */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { isSupportedLanguage } from './languages';
import en from './locales/en.json';

type Catalog = Record<string, unknown>;

function flatten(
  value: Catalog,
  prefix = '',
  out = new Map<string, string>()
): Map<string, string> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child as Catalog, path, out);
    } else {
      out.set(path, String(child));
    }
  }
  return out;
}

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;
const pluralBase = (key: string) =>
  PLURAL_SUFFIX.test(key) ? key.replace(PLURAL_SUFFIX, '') : null;

const english = flatten(en as unknown as Catalog);
const englishFamilies = new Set(
  [...english.keys()].map(key => pluralBase(key)).filter((base): base is string => base !== null)
);

/**
 * The catalogs to check come from the locale files on disk, not a second
 * hand-kept list. `SUPPORTED_LANGUAGES` is the app's list and must match the
 * directory — `check-catalogs.mjs` fails when it does not — but a test that
 * iterates a copy of it silently stops covering a catalog the day one is added
 * or removed. Read the directory so this test names exactly the files that
 * exist.
 */
const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locales');

const LOCALE_TAGS = readdirSync(LOCALE_DIR)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -'.json'.length))
  .toSorted();

const NON_ENGLISH_LOCALES = LOCALE_TAGS.filter(tag => tag !== 'en');

/**
 * Load one catalog through the loader the app itself parses. Narrow the
 * directory-derived name first: a locale file for a tag the app does not
 * support is a failure this test must report, not a name that indexes
 * `CATALOG_LOADERS` to `undefined`.
 */
function loadCatalog(tag: string): Catalog {
  if (!isSupportedLanguage(tag)) {
    throw new TypeError(`locale file "${tag}.json" is not a supported language`);
  }
  return CATALOG_LOADERS[tag]() as unknown as Catalog;
}

/**
 * A key that leaves en.json is dead copy: it never renders, and
 * `tools/i18n/check-catalogs.mjs` (run by `check:i18n`) fails the build until it
 * is gone. Plural categories the language needs are the only allowed extra.
 */
describe('catalog parity', () => {
  /**
   * `it.each([])` would run nothing and pass, so pin the two facts that make
   * every check below cover anything at all.
   */
  it('reads the catalogs from the locale files that exist', () => {
    expect(LOCALE_TAGS.length).toBeGreaterThan(0);
    expect(LOCALE_TAGS).toContain('en');
  });

  it.each(NON_ENGLISH_LOCALES)('%s has no key that en.json does not define', tag => {
    const catalog = flatten(loadCatalog(tag));
    const extra = [...catalog.keys()].filter(key => {
      if (english.has(key)) {
        return false;
      }
      const base = pluralBase(key);
      return !(base !== null && englishFamilies.has(base));
    });
    expect(extra, `${tag} carries keys absent from en.json`).toEqual([]);
  });

  /**
   * The launcher surfaces label New agent from `glanceable.newAgent`
   * (`src/lib/launcher-surfaces-publish.ts`), so `launcher.newAgent` is dead
   * copy that `check:i18n` rejects as an extra key. It shipped in every
   * non-English catalog once; pin its absence so it cannot come back.
   */
  it('no catalog defines the dead launcher.newAgent key', () => {
    const offenders = NON_ENGLISH_LOCALES.filter(tag => {
      const catalog = flatten(loadCatalog(tag));
      return catalog.has('launcher.newAgent');
    });
    expect(offenders, 'catalogs carry dead launcher.newAgent copy').toEqual([]);
  });

  /**
   * A stray `launcher.*` key is dead copy for the same reason: the launcher
   * surfaces label New agent from `glanceable.newAgent`. Pin the whole scope,
   * not only the one key that shipped, so any future launcher copy that
   * en.json does not define fails here.
   */
  it('every catalog agrees with en.json on the launcher scope', () => {
    const englishLauncher = [...english.keys()]
      .filter(key => key.startsWith('launcher.'))
      .toSorted()
      .join(',');
    const offenders = NON_ENGLISH_LOCALES.filter(tag => {
      const catalog = flatten(loadCatalog(tag));
      const launcher = [...catalog.keys()]
        .filter(key => key.startsWith('launcher.'))
        .toSorted()
        .join(',');
      return launcher !== englishLauncher;
    });
    expect(offenders, 'catalogs disagree with en.json on the launcher scope').toEqual([]);
  });

  /**
   * The per-language check passes whenever English and the catalog drift
   * together, so a dead key re-added to the reference would slip through it.
   * Pin the English launcher scope to the one key a call site reads.
   */
  it('en.json defines only the live launcher key', () => {
    const launcher = [...english.keys()].filter(key => key.startsWith('launcher.'));
    expect(launcher).toEqual(['launcher.openLastSession']);
  });
});
