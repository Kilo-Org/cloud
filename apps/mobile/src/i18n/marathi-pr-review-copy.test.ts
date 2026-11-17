import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { buildDiffLineAccessibilityLabel } from '@/lib/pr-review/diff/parse-patch';

/**
 * Marathi marks agreement on the verb, not on the counted noun, so a bucket
 * phrase whose `_one` repeats its `_other` participle reads as plural at a
 * count of one. The check rollup passes `count`, so "1 skipped" resolved to the
 * plural `वगळल्या`. The three connection titles are title-style copy: the
 * English strings and every sibling title in the block carry no terminal stop,
 * so a stop here is a second convention inside one dialog.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('mr');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Marathi pull-request review copy', () => {
  it('agrees with a single skipped check and keeps the plural form above one', () => {
    expect(i18n.t('prReview.checks.skipped', { count: 1, displayCount: '1' })).toBe('1 वगळली');
    expect(i18n.t('prReview.checks.skipped', { count: 3, displayCount: '3' })).toBe('3 वगळल्या');
  });

  it('names the organization with one term across the Bitbucket gate', () => {
    expect(i18n.t('prReview.connect.bitbucketOrgOnlyDescription')).toContain('संस्थेत');
    expect(i18n.t('prReview.connect.bitbucketOrgOnlyNoOrganizationDescription')).toContain(
      'कोणतीही संस्था'
    );
    expect(i18n.t('prReview.connect.bitbucketOrgOnlyNoOrganizationDescription')).toContain(
      'संस्था तयार'
    );
  });

  it('leaves the connection-failure titles without a terminal stop', () => {
    for (const key of [
      'prReview.connect.checkFailedTitle',
      'prReview.connect.checkFailedTitleGitLab',
      'prReview.connect.checkFailedTitleBitbucket',
    ]) {
      expect(i18n.t(key), key).not.toMatch(/\.$/);
    }
  });

  it('labels a diff line without a number without promising one', () => {
    expect(
      buildDiffLineAccessibilityLabel({
        type: 'add',
        text: 'const a = 1;',
        noNewlineAtEndOfFile: false,
      })
    ).toBe('जोडले: const a = 1;');
    // The numbered sibling keeps the noun, so one shape did not replace the other.
    expect(
      buildDiffLineAccessibilityLabel({
        type: 'context',
        oldLine: 3,
        newLine: 3,
        text: 'export default greeting;',
        noNewlineAtEndOfFile: false,
      })
    ).toBe('संदर्भ ओळ 3: export default greeting;');
  });
});
