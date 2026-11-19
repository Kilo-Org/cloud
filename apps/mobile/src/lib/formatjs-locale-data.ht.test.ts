import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Haitian Creole's plural selection must stay Haitian, not follow whichever
 * locale-data module registered most recently.
 *
 * CLDR gives `ht` no plural-rules block of its own: it inherits the root rule,
 * whose selection (`one` only for n = 1) the `en` data file carries. The
 * polyfill resolves a requested locale against the data modules that have
 * registered so far, so a bare `en` entry answers correctly only until
 * `fr.js` registers (the language picker's switch loads French data), after
 * which `ht` silently reports French categories — `one` for 0 and 0.5, and a
 * `many` form no ht catalog family carries. The `ht` loader pins the
 * root-shaped dataset under `ht` itself, so selection is order-independent.
 *
 * The pin-first order lives in `formatjs-locale-data.ht-french-first.test.ts`:
 * a separate file, because a fresh worker is the only way to give a case the
 * first and only polyfill attach, a fresh `intl-cache` module (both module
 * guards start unset) and an untouched package cache — the polyfill cannot be
 * re-attached to a later stubbed `Intl` window inside one worker.
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

describe('ht plural-data pin', () => {
  it('pins ht when its data registers before the French data', async () => {
    // The module must load inside the stubbed window, so the dynamic import
    // here is the point of the test (module-loading boundary).
    const { prewarmIntl } = await import('./intl-cache');

    prewarmIntl('ht');
    prewarmIntl('fr');

    expect(new Intl.PluralRules('ht').resolvedOptions().locale).toBe('ht');
    expect(new Intl.PluralRules('ht').resolvedOptions().pluralCategories).toEqual(['one', 'other']);
    expect(new Intl.PluralRules('ht').select(0)).toBe('other');
    expect(new Intl.PluralRules('ht').select(0.5)).toBe('other');
    expect(new Intl.PluralRules('ht').select(1)).toBe('one');
    // No `many` for exact millions: the ht catalog carries no `_many` form.
    expect(new Intl.PluralRules('ht').select(1_000_000)).toBe('other');
    // French keeps its own rule (its catalog carries `_many` on all families).
    expect(new Intl.PluralRules('fr').resolvedOptions().pluralCategories).toEqual([
      'one',
      'many',
      'other',
    ]);
    expect(new Intl.PluralRules('fr').select(0)).toBe('one');
    expect(new Intl.PluralRules('fr').select(1_000_000)).toBe('many');
  });
});
