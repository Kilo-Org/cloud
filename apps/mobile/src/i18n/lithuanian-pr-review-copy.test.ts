import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The Lithuanian catalog used a second word for the same English "Open" in the
 * standalone open chip, so it did not read like the combined chips on the same
 * screen. The unavailable copy named an unspecified service, and the file
 * field named a field instead of the filter action.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('lt');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Lithuanian pull-request review copy', () => {
  it('reads the open chip like the combined chips on the same screen', () => {
    const open = i18n.t('prReview.overview.stateOpen');
    expect(i18n.t('prReview.overview.stateOpenApproved').startsWith(open)).toBe(true);
    expect(i18n.t('prReview.overview.stateOpenReviewRequired').startsWith(open)).toBe(true);
  });

  it('names the review service in the unavailable copy', () => {
    expect(i18n.t('prReview.reviewServiceUnavailable')).toContain('Peržiūros');
    expect(i18n.t('prReview.reviewServiceUnavailableDescription')).toContain('Peržiūros');
  });

  it('asks the file field to filter by path', () => {
    expect(i18n.t('prReview.fileNavigator.filterPlaceholder').startsWith('Filtruoti')).toBe(true);
  });
});
