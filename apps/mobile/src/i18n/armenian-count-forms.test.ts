import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Armenian takes the singular noun after a numeral and has only the `one` and
 * `other` categories, so a counted family's `_one` entry carries the noun a
 * numeral governs. Each family below shipped a `_one` entry that repeated its
 * plural noun, or a plural that disagreed with the numeral beside it: `1
 * տողերը`, `5 ֆայլեր`, `1 տեղեր`, a queued count that named the findings two
 * ways, a deadline label that changed its word at the plural boundary, and a
 * share notice that used the plural verb at one. Both categories are pinned
 * here, so a copy that flattens the family again fails.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('hy');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Armenian counted copy', () => {
  it('keeps the singular noun after a numeral in the diff expand rows', () => {
    expect(i18n.t('prReview.hunkRows.expandAllLines', { count: 1, displayCount: '1' })).toBe(
      'Ցույց տալ բոլոր 1 տող'
    );
    expect(i18n.t('prReview.hunkRows.expandAllLines', { count: 3, displayCount: '3' })).toBe(
      'Ցույց տալ բոլոր 3 տողերը'
    );
    expect(
      i18n.t('prReview.hunkRows.expandLines', {
        count: 1,
        displayCount: '1',
        start: '4',
        end: '4',
      })
    ).toBe('Ցույց տալ 1 տող (4–4)');
  });

  it('keeps the overview file count singular beside the numeral', () => {
    expect(i18n.t('prReview.overview.file', { count: 1 })).toBe('ֆայլ');
    expect(i18n.t('prReview.overview.file', { count: 5 })).toBe('ֆայլ');
    expect(i18n.t('prReview.overview.file')).toBe('ֆայլեր');
  });

  it('inflects the location count of the analysis panel', () => {
    expect(i18n.t('securityAgent.analysis.whereFound', { count: 1, displayCount: '1' })).toBe(
      'Հայտնաբերման տեղ (1)'
    );
    expect(i18n.t('securityAgent.analysis.whereFound', { count: 2, displayCount: '2' })).toBe(
      'Հայտնաբերման տեղեր (2)'
    );
  });

  it('names the queued findings one way in both categories', () => {
    expect(i18n.t('securityAgent.automation.queued', { count: 1, displayCount: '1' })).toBe(
      '1 առկա խնդիր հերթագրվել է վերլուծության համար։'
    );
    expect(i18n.t('securityAgent.automation.queued', { count: 4, displayCount: '4' })).toBe(
      '4 առկա խնդիր հերթագրված են վերլուծության համար։'
    );
  });

  it('uses one word for the overdue deadline at both counts', () => {
    expect(i18n.t('securityAgent.deadline.overdue', { count: 1 })).toBe('1 օր ժամկետանց');
    expect(i18n.t('securityAgent.deadline.overdue', { count: 5 })).toBe('5 օր ժամկետանց');
  });

  it('agrees the share notice with the file it names', () => {
    expect(i18n.t('share.onlyFirstFilesAttached', { count: 1, displayCount: '1' })).toBe(
      'Կկցվի միայն առաջին 1 ֆայլը։'
    );
    expect(i18n.t('share.onlyFirstFilesAttached', { count: 3, displayCount: '3' })).toBe(
      'Կկցվեն միայն առաջին 3 ֆայլերը։'
    );
  });
});
