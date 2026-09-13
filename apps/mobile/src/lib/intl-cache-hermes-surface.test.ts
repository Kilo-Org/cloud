import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermes ships only these Intl members. Everything else must come from a polyfill.
function stubHermesIntl(): void {
  const nativeIntl = Intl;
  vi.stubGlobal('Intl', {
    Collator: nativeIntl.Collator,
    DateTimeFormat: nativeIntl.DateTimeFormat,
    getCanonicalLocales: nativeIntl.getCanonicalLocales,
  });
}

describe('Hermes Intl surface', () => {
  // Formatting every supported language through the Hermes Intl stub is the
  // heaviest pure test; under the full related-suite running concurrently with
  // the device stack it exceeds the 5 s default (b911 gate flake, 2026-09-08).
  const allLanguagesTimeoutMs = 30_000;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Every supported language runs the full polyfill path and loads its locale
  // data. That is the point of the guard, and it costs seconds on a loaded CI
  // box — well past the 5s default. The formatters and i18next are imported
  // inside the test, so their transform runs on the test clock too: this body
  // carries its own budget. Same sizing as auth-context.test.tsx.
  it(
    'formats every supported language and pluralizes for i18next',
    async () => {
      stubHermesIntl();
      const { SUPPORTED_LANGUAGES } = await import('@/i18n/languages');
      const { prewarmIntl, collator, dateTimeFormat } = await import('./intl-cache');
      const format = await import('./format');
      const { timeAgo } = await import('./utils');

      for (const language of SUPPORTED_LANGUAGES) {
        prewarmIntl(language);
        expect(format.formatMoney(1234.5, language)).toBeTruthy();
        expect(format.formatNumber(3, language)).toBeTruthy();
        expect(format.formatPercent(0.5, language)).toBeTruthy();
        expect(format.formatList(['a', 'b', 'c'], language)).toBeTruthy();
        expect(format.formatDuration(3725, language)).toBeTruthy();
        expect(format.formatFileSize(2048, language)).toBeTruthy();
        expect(format.firstGrapheme('👍🏽x', language)).toBe('👍🏽');
        expect(format.formatDate(new Date(0), language)).toBeTruthy();
        expect(collator(language).compare('a', 'b')).toBeLessThan(0);
        expect(dateTimeFormat(language, { hour: 'numeric' }).format(new Date(0))).toBeTruthy();
        expect(timeAgo(new Date(Date.now() - 3 * 86_400_000), language)).toBeTruthy();
      }

      // i18next builds its own Intl.PluralRules; without the polyfill it silently
      // falls back to English one/other and caches that per language.
      const { i18n } = await import('@/i18n');
      prewarmIntl('ru');
      await i18n.changeLanguage('ru');
      const few = i18n.t('prReview.hunkRows.fileLoadedCount', { count: 2, displayCount: '2' });
      const many = i18n.t('prReview.hunkRows.fileLoadedCount', { count: 5, displayCount: '5' });
      expect(few).not.toBe(many);
    },
    allLanguagesTimeoutMs
  );
});
