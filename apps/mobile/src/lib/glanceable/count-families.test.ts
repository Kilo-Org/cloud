import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { prewarmIntl } from '@/lib/intl-cache';

import {
  type GlanceableCountKind,
  glanceableCountMessage,
  glanceableCountNoun,
} from './presentation';
import { glanceableTranslate } from './translate';

/**
 * The count families through the real i18next instance and the real catalogs.
 *
 * A mock translator can prove the call shape; only the copy that ships can
 * prove the keys resolve, the singular resolves to `_one` and the formatted
 * clock reaches the message. English is bundled into the instance, so the
 * English cases need no locale data.
 */
const KINDS: GlanceableCountKind[] = ['needsInput', 'running', 'scheduled', 'idle'];

describe('glanceable count families', () => {
  it('selects the singular form for one and the plural form otherwise', () => {
    for (const kind of KINDS) {
      expect(glanceableCountMessage(kind, 1, String, glanceableTranslate)).toBe(
        glanceableTranslate(`glanceable.count.${kind}_one`, { count: 1, displayCount: '1' })
      );
      expect(glanceableCountMessage(kind, 2, String, glanceableTranslate)).toBe(
        glanceableTranslate(`glanceable.count.${kind}_other`, { count: 2, displayCount: '2' })
      );
      expect(glanceableCountMessage(kind, 1, String, glanceableTranslate)).toBe(
        `1 ${glanceableCountNoun(kind, 1, glanceableTranslate)}`
      );
    }
  });

  it('interpolates the formatted count, not the raw number', () => {
    const grouped = (value: number) => `digit:${value}`;
    expect(glanceableCountMessage('running', 1234, grouped, glanceableTranslate)).toBe(
      'digit:1234 Working'
    );
    expect(glanceableCountMessage('running', 1, grouped, glanceableTranslate)).toBe(
      'digit:1 Working'
    );
  });

  it('interpolates the formatted clock into the footer and wake lines', () => {
    expect(glanceableTranslate('glanceable.footer.checked', { time: '8:00 PM' })).toBe(
      'Checked 8:00 PM'
    );
    expect(glanceableTranslate('glanceable.footer.lastKnown', { time: '8:00 PM' })).toBe(
      'Last known · 8:00 PM'
    );
    expect(glanceableTranslate('glanceable.wake.nextRun', { time: '8:00 PM' })).toBe(
      'Next run 8:00 PM'
    );
    expect(glanceableTranslate('glanceable.wake.wasDue', { time: '8:00 PM' })).toBe(
      'Was due 8:00 PM'
    );
  });
});

/**
 * The same families in a language with more than two categories, through the
 * real instance and the real Russian catalog. This exercises the category
 * selection itself; the call order that keeps the rules from being cached
 * before the polyfill is pinned in `apply-stored-language.test.ts`.
 */
describe('glanceable count families in a multi-category language', () => {
  it('resolves one, few and many for the two families that inflect', async () => {
    prewarmIntl('ru');
    await i18n.changeLanguage('ru');
    try {
      const needsInput = [1, 2, 5].map(count =>
        glanceableCountMessage('needsInput', count, String, glanceableTranslate)
      );
      const idle = [1, 2, 5].map(count =>
        glanceableCountMessage('idle', count, String, glanceableTranslate)
      );
      // Russian's `few` (2) and `many` (5) differ for these nouns.
      expect(needsInput[0]).not.toBe(needsInput[1]);
      expect(needsInput[1]).not.toBe(needsInput[2]);
      expect(idle[0]).not.toBe(idle[2]);
      expect(glanceableCountNoun('idle', 5, glanceableTranslate)).toBe(
        glanceableTranslate('glanceable.countNoun.idle_many')
      );
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
