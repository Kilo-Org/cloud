import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

/**
 * The four labels a stopped session draws on its glanceable card: the Android
 * card's `FAILURE_KEYS`, and the layout copy the widget surfaces bake at
 * registration. English sets them in sentence case: `Stopped` beside
 * `Stopped: provider error` and its siblings. One translated catalog set the
 * bare label in capitals while its three qualified siblings kept sentence case,
 * so the same state read two ways on one card. The labels are pinned here so a
 * later translation batch cannot bring the capitals back.
 */

const FAILURE_KINDS = ['provider', 'tool', 'cancelled', 'other'] as const;

/** English source, so the pinned casing has a stated origin. */
const ENGLISH: Record<(typeof FAILURE_KINDS)[number], string> = {
  provider: 'Stopped: provider error',
  tool: 'Stopped: tool error',
  cancelled: 'Stopped: cancelled',
  other: 'Stopped',
};

/** One catalog value by dotted key, or undefined when the catalog lacks it. */
function catalogValue(tag: SupportedLanguage, key: string): string | undefined {
  let node: unknown = CATALOG_LOADERS[tag]();
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

describe('glanceable failure copy', () => {
  it('keeps the English failure labels in sentence case', () => {
    for (const kind of FAILURE_KINDS) {
      expect(catalogValue('en', `glanceable.failure.${kind}`)).toBe(ENGLISH[kind]);
    }
  });

  it.each(SUPPORTED_LANGUAGES)(
    'sets every failure label in sentence case, not capitals, in %s',
    tag => {
      // Georgian writes Mkhedruli, which has one case: its uppercase mapping
      // lands in the Mtavruli block, so the catalog's own letter is never a
      // capital and there is no sentence-case form to hold it to.
      if (tag === 'ka') {
        return;
      }
      for (const kind of FAILURE_KINDS) {
        const value = catalogValue(tag, `glanceable.failure.${kind}`);
        expect(value, `${tag} glanceable.failure.${kind}`).toBeTruthy();
        const letters = [...String(value)];
        const firstCased = letters.find(
          letter => letter.toLocaleLowerCase('en') !== letter.toLocaleUpperCase('en')
        );
        // A script without letter case (Han, Arabic, Devanagari, …) has no
        // sentence-case form, so only a cased value is held to one.
        if (firstCased === undefined) {
          continue;
        }
        expect(value, `${tag} glanceable.failure.${kind} is set in capitals`).not.toBe(
          String(value).toLocaleUpperCase(tag)
        );
        expect(value, `${tag} glanceable.failure.${kind} must start with a capital letter`).toBe(
          String(value).replace(firstCased, firstCased.toLocaleUpperCase(tag))
        );
      }
    }
  );
});
