import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';

/**
 * The non-English catalogs are translated against English, so a catalog may
 * never carry a key en.json does not define: no screen would render the copy,
 * and it would reach a reader only as dead weight or, worse, the wrong label.
 * `tools/i18n/check-catalogs.mjs` enforces this for the whole tree; this test
 * pins the same invariant where a regression surfaces first, the moment a
 * catalog keeps a key the English source dropped. `launcher.newAgent` shipped
 * exactly that way: the shortcut now names `glanceable.newAgent`, but all 86
 * catalogs still carried the stale key.
 */

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') {
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, out);
    } else {
      out.add(path);
    }
  }
  return out;
}

const english = flatten(CATALOG_LOADERS.en());

/**
 * A language may need a plural category English has not got, so an extra
 * sibling of a family English defines is legitimate; any other extra key is
 * leftover copy. Mirrors the family exemption in check-catalogs.mjs.
 */
const englishPluralBases = new Set(
  [...english].filter(key => PLURAL_SUFFIX.test(key)).map(key => key.replace(PLURAL_SUFFIX, ''))
);

function isPluralSibling(key: string): boolean {
  const match = PLURAL_SUFFIX.exec(key);
  return match !== null && englishPluralBases.has(key.slice(0, -match[0].length));
}

describe('catalog parity', () => {
  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))(
    '%s defines no key en.json omits',
    tag => {
      const translated = flatten(CATALOG_LOADERS[tag]());
      const extra = [...translated].filter(key => !english.has(key) && !isPluralSibling(key));
      expect(extra).toEqual([]);
    }
  );
});

/**
 * The launcher shortcuts name the one shared copy at `glanceable.newAgent`.
 * A catalog that keeps its own `launcher.newAgent` renders dead copy that
 * drifts from the quick-settings tile label, which reads the shared key.
 * Pinned here by name, next to the generic extra-key rule above, so the
 * regression cannot return silently.
 */
describe('launcher shortcuts reuse the shared new-agent copy', () => {
  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))('%s', tag => {
    const translated = CATALOG_LOADERS[tag]() as {
      launcher?: Record<string, unknown>;
      glanceable?: Record<string, unknown>;
    };
    expect(translated.launcher?.newAgent).toBeUndefined();
    expect(translated.launcher?.openLastSession).toBeDefined();
    expect(translated.glanceable?.newAgent).toBeDefined();
  });
});
