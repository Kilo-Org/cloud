import { describe, expect, it, vi } from 'vitest';

import { HOME_WIDGET_TITLE_LIMIT } from '@kilocode/app-shared/home-widget';
import { sessionLiveActivityTitle } from '@kilocode/notifications/schemas';

import { applyStoredLanguage } from './apply-stored-language';

vi.mock('@/i18n', () => ({
  i18n: { changeLanguage: vi.fn(() => Promise.resolve()), language: 'en' },
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  whenLanguagePreferenceLoaded: () => Promise.resolve(),
}));

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
const HEAD = 'x'.repeat(HOME_WIDGET_TITLE_LIMIT - 7);

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
});
