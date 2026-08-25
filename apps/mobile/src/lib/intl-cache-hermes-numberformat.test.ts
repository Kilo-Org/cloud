import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Hermes NumberFormat compatibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('polyfills currency parts and unit formatting when NumberFormat is missing', async () => {
    const nativeIntl = Intl;
    vi.stubGlobal('Intl', {
      Collator: nativeIntl.Collator,
      DateTimeFormat: nativeIntl.DateTimeFormat,
      getCanonicalLocales: nativeIntl.getCanonicalLocales,
      PluralRules: nativeIntl.PluralRules,
    });

    const { prewarmIntl } = await import('./intl-cache');
    prewarmIntl('de');
    const { formatFileSize, formatMoney } = await import('./format');

    expect(formatMoney(1234.5, 'de')).toMatch(/1\.234,50[\s\u00A0\u202F]+\$/);
    expect(formatFileSize(1024, 'de')).toContain('1 kB');
  });
});
