import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Telugu headings that are labels rather than sentences. The reconnect notice
 * titles, the review load-failure titles and the query error headings all render
 * as a heading above their own message, so the English strings carry no terminal
 * stop and the Telugu ones must not add one. A stop here also reads as a
 * finished sentence where the key supplies a title slot.
 */

beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Telugu pull-request review headings', () => {
  it('keeps each provider reconnect title without a terminal stop', () => {
    expect(i18n.t('prReview.reconnectNotice.title')).toBe('GitHub కనెక్షన్ గడువు ముగిసింది');
    expect(i18n.t('prReview.reconnectNotice.gitlabTitle')).toBe('GitLab కనెక్షన్ గడువు ముగిసింది');
    expect(i18n.t('prReview.reconnectNotice.bitbucketTitle')).toBe('Bitbucket కనెక్షన్ గడువు ముగిసింది');
  });

  it('keeps the review and merge-request load titles without a terminal stop', () => {
    expect(i18n.t('prReview.submit.loadFailedTitle')).toBe('సమీక్ష సమర్పించే స్క్రీన్‌ను లోడ్ చేయలేకపోయాము');
    expect(i18n.t('prReview.terms.couldNotLoadMergeRequest')).toBe('మెర్జ్ రిక్వెస్ట్‌ను లోడ్ చేయలేకపోయాము');
  });
});

describe('Telugu query error headings', () => {
  it('keeps both failure headings without a terminal stop, like the timeout heading', () => {
    for (const key of [
      'queryError.offlineTitle',
      'queryError.serverTitle',
      'queryError.timeoutTitle',
    ]) {
      expect(i18n.t(key), key).not.toMatch(/\.$/u);
    }
    expect(i18n.t('queryError.offlineTitle')).toBe('లోడ్ చేయడం విఫలమైంది');
    expect(i18n.t('queryError.serverTitle')).toBe('లోడ్ చేయలేకపోయాము');
  });
});
