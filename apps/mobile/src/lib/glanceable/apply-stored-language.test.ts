import { describe, expect, it, vi } from 'vitest';

import type * as IntlCache from '@/lib/intl-cache';

import { GLANCEABLE_TITLE_LIMIT } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { sessionLiveActivityTitle } from '@kilocode/notifications/schemas';

import { applyStoredLanguage } from './apply-stored-language';

const order = vi.hoisted(() => ({ calls: [] as string[], language: 'en' }));

vi.mock('@/i18n', () => ({
  i18n: {
    changeLanguage: vi.fn(() => {
      order.calls.push('change');
      return Promise.resolve();
    }),
    language: 'en',
  },
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => order.language,
  whenLanguagePreferenceLoaded: () => Promise.resolve(),
}));
vi.mock('@/lib/intl-cache', async importOriginal => {
  const actual = await importOriginal<typeof IntlCache>();
  return {
    ...actual,
    prewarmIntl: (locale: string) => {
      order.calls.push('prewarm');
      actual.prewarmIntl(locale);
    },
  };
});

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
const HEAD = 'x'.repeat(GLANCEABLE_TITLE_LIMIT - 7);

describe('applyStoredLanguage', () => {
  it('installs the segmenter a headless surface cuts its text with', async () => {
    // Hermes has no `Intl.Segmenter`, and a widget or notification process boots
    // without the root layout that warms the polyfill for the foreground app.
    const nativeSegmenter = Intl.Segmenter;
    const title = `${HEAD}${FAMILY}`;
    Reflect.deleteProperty(Intl, 'Segmenter');
    try {
      // Before the warm, a cut that lands inside the family keeps what it fit.
      expect(sessionLiveActivityTitle(title)).toBe(`${HEAD}\u{1F468}\u200D\u{1F469}\u200D`);
      await applyStoredLanguage();
      expect(Intl.Segmenter).toBeTypeOf('function');
      // The same running process now cuts on the whole character, so the title
      // drops the family instead of ending on a joiner.
      expect(sessionLiveActivityTitle(title)).toBe(HEAD);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', {
        configurable: true,
        value: nativeSegmenter,
        writable: true,
      });
    }
  });

  it('warms Intl before it changes the language', async () => {
    // i18next memoises each language's plural rule on first resolve, so a change
    // that lands first leaves English's one/other pair for the process.
    order.calls = [];
    order.language = 'ru';
    try {
      await applyStoredLanguage();
      expect(order.calls).toEqual(['prewarm', 'change']);
    } finally {
      order.language = 'en';
    }
  });
});
