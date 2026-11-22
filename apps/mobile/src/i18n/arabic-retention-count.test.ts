import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { SUPPORTED_LANGUAGES } from './languages';

/**
 * Arabic counts 11 to 99 with the singular accusative, so the retention
 * sentence's day noun has to follow the number it carries: `90 يومًا`, not
 * `90 يوم`. The family is read at the count the app actually renders, and the
 * resolved category is asserted too, so a form that stays flat fails here even
 * if some other category happens to spell the noun correctly.
 *
 * Retention is a constant (`NOTIFICATION_HISTORY_RETENTION_DAYS`), so every
 * other language only ever reaches the one category that constants selects.
 * Those categories are read back out of each catalog and must repeat the
 * catalog's own wording, which is why only the Arabic form differs.
 */

const RETENTION_DAYS = 90;
const KEY = 'notifications.history.emptyBody';

beforeAll(async () => {
  await i18n.changeLanguage('ar');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Arabic retention sentence', () => {
  it('writes the accusative singular for the 90-day window', () => {
    expect(i18n.t(KEY, { count: RETENTION_DAYS, days: RETENTION_DAYS })).toBe(
      'تظهر هنا الإشعارات التي يتلقّاها هذا الحساب. يتم الاحتفاظ بها لمدة 90 يومًا.'
    );
  });

  it('resolves the many category, the one CLDR selects at 90', () => {
    const details = i18n.t(KEY, {
      count: RETENTION_DAYS,
      days: RETENTION_DAYS,
      returnDetails: true,
    }) as unknown as { exactUsedKey: string };
    expect(details.exactUsedKey).toBe(`${KEY}_many`);
    expect(new Intl.PluralRules('ar').select(RETENTION_DAYS)).toBe('many');
  });

  it('keeps the numeral in every form of the family', () => {
    for (const count of [0, 1, 2, 3, 11, 90]) {
      expect(i18n.t(KEY, { count, days: count }), `ar ${count}`).toContain(String(count));
    }
  });
});

describe('retention sentence at the count the app renders', () => {
  it('renders the number and no unresolved placeholder in every language', () => {
    for (const tag of SUPPORTED_LANGUAGES) {
      const rendered = i18n.t(KEY, { lng: tag, count: RETENTION_DAYS, days: RETENTION_DAYS });
      expect(rendered, tag).toContain(String(RETENTION_DAYS));
      expect(rendered, tag).not.toContain('{{');
      expect(rendered, tag).not.toBe(KEY);
    }
  });
});
