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
 */

// One polyfill attach per worker: `polyfill-force.js` is an externalized ESM
// module, so `vi.resetModules()` does not re-evaluate it — only the FIRST
// stubbed `Intl` window sees the install, and every later stub would hide the
// polyfilled `PluralRules`. The whole file therefore shares one stub, and the
// two register orders run against the same polyfill.
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

  it('keeps ht pinned when the French data registers first', async () => {
    // Fresh `intl-cache` module state so the loader's own bookkeeping restarts;
    // the polyfill itself persists (see the file comment above).
    const { prewarmIntl } = await import('./intl-cache');

    prewarmIntl('fr');
    prewarmIntl('ht');
    // Re-registering the French data is what a runtime process order does when
    // a user lands in French and switches later; the pin must survive it.
    prewarmIntl('fr');

    expect(new Intl.PluralRules('ht').resolvedOptions().locale).toBe('ht');
    expect(new Intl.PluralRules('ht').resolvedOptions().pluralCategories).toEqual(['one', 'other']);
    expect(new Intl.PluralRules('ht').select(0)).toBe('other');
    expect(new Intl.PluralRules('ht').select(0.5)).toBe('other');
    expect(new Intl.PluralRules('ht').select(1)).toBe('one');
    expect(new Intl.PluralRules('ht').select(1_000_000)).toBe('other');
  });
});
