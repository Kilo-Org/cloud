import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Marathi marks the plural on the counted noun and on the verb that agrees
 * with it, so a family whose `_one` entry repeats its `_other` copy never
 * inflects for the count that selects it. This pins the
 * `agentChat.partRenderer.updatedFileCount` family to the same file noun the
 * PR-review surfaces use after this change: फाइल at 1, फाइल्स above.
 */

beforeAll(async () => {
  await i18n.changeLanguage('mr');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Marathi count-one copy', () => {
  it('inflects the updated-file count to the singular at one', () => {
    expect(i18n.t('agentChat.partRenderer.updatedFileCount', { count: 1, displayCount: '1' })).toBe(
      '1 फाइल अद्ययावत केली.'
    );
  });

  it('keeps the plural above one', () => {
    expect(i18n.t('agentChat.partRenderer.updatedFileCount', { count: 2, displayCount: '2' })).toBe(
      '2 फाइल्स अद्ययावत केल्या.'
    );
  });

  it('keeps the PR-review families on the shared plural', () => {
    expect(i18n.t('prReview.fileNavigator.title')).toBe('फाइल्स');
    expect(i18n.t('prReview.tabs.files')).toBe('फाइल्स');
    expect(i18n.t('prReview.overview.file')).toBe('फाइल्स');
    expect(i18n.t('prReview.diff.truncationBanner', { count: 1, limit: '3,000', total: '1' })).toBe(
      'GitHub API च्या मर्यादेमुळे बदललेल्या 1 फाइलपैकी पहिल्या 3,000 फाइल्स दाखवल्या आहेत.'
    );
  });
});
