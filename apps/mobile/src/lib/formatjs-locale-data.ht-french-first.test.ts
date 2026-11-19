import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The French-first registration order for the Haitian Creole plural pin.
 *
 * Companion to `formatjs-locale-data.ht.test.ts`, which documents the pin.
 * This file must stay a separate worker: the polyfill attaches to the first
 * stubbed `Intl` window only (`polyfill-force.js` is externalized, so a later
 * `vi.resetModules()` cannot re-attach it), and a fresh worker is also what
 * starts `intl-cache` with both module guards unset — the pin guard and the
 * polyfill-install flag. That is the only state in which the order below is
 * exercised for real: French data first, the pinned `ht` loader second, then
 * French rewarming. A pin that broke for this order fails here.
 */
const nativeIntl = Intl;

vi.stubGlobal('Intl', {
  Collator: nativeIntl.Collator,
  DateTimeFormat: nativeIntl.DateTimeFormat,
  getCanonicalLocales: nativeIntl.getCanonicalLocales,
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('ht plural-data pin, French-first order', () => {
  it('keeps ht pinned when the French data registers first', async () => {
    // This host's native ICU serves `fr` itself, so `prewarmIntl('fr')` would
    // install nothing here; the test registers the French data the way the
    // device runtime does — through the polyfill the app force-installs.
    await import('@formatjs/intl-pluralrules/polyfill-force.js');
    await import('@formatjs/intl-pluralrules/locale-data/fr.js');
    const { prewarmIntl } = await import('./intl-cache');

    prewarmIntl('fr');
    prewarmIntl('ht');
    prewarmIntl('fr');

    expect(new Intl.PluralRules('ht').resolvedOptions().locale).toBe('ht');
    expect(new Intl.PluralRules('ht').resolvedOptions().pluralCategories).toEqual(['one', 'other']);
    expect(new Intl.PluralRules('ht').select(0)).toBe('other');
    expect(new Intl.PluralRules('ht').select(0.5)).toBe('other');
    expect(new Intl.PluralRules('ht').select(1)).toBe('one');
    // No `many` for exact millions: the ht catalog carries no `_many` form.
    expect(new Intl.PluralRules('ht').select(1_000_000)).toBe('other');
    // French itself is unchanged by the pin.
    expect(new Intl.PluralRules('fr').resolvedOptions().pluralCategories).toEqual([
      'one',
      'many',
      'other',
    ]);
    expect(new Intl.PluralRules('fr').select(0)).toBe('one');
    expect(new Intl.PluralRules('fr').select(1_000_000)).toBe('many');
  });
});
