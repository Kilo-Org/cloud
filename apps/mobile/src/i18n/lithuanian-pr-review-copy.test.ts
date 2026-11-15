import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPrMergeTitles } from '@/components/pr-review/merge/pr-merge-titles';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { i18n } from '@/i18n';
import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';

/**
 * Lithuanian `peržiūrėti` takes an accusative object, `į` takes the accusative
 * and `sujungti` takes the accusative too, so a noun interpolated in the
 * nominative could not sit inside any of those phrases. The catalog now names
 * the GitLab object as the feminine "sujungimo užklausa", which declines like
 * the feminine "pakeitimų užklausa", and each sentence keeps the noun in a
 * trailing label so the text before it stays complete without the noun.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('lt');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

const PLATFORMS: readonly ProviderPrPlatform[] = ['github', 'gitlab'];

/** The rendered sentence for a provider platform's noun. */
function withTerm(key: string, platform: ProviderPrPlatform): string {
  return i18n.t(key, { term: i18n.t(providerPrNounKey(platform)) });
}

describe('Lithuanian merge action and heading', () => {
  it('words the action as a verb and the heading as a noun', () => {
    const action = i18n.t('prReview.merge.merge');
    expect(action).not.toBe(i18n.t('prReview.merge.mergeTitle'));
    // The merge screen and the section button both consume the helper, so on
    // GitLab its action has to be the bare verb the button shows.
    expect(providerPrMergeTitles(i18n.t, 'gitlab').action).toBe(action);
  });
});

describe('Lithuanian provider-noun sentences', () => {
  it('keeps the noun out of the verb phrase on both platform nouns', () => {
    const KEYS = [
      'prReview.discussion.replyForbiddenTerm',
      'prReview.merge.mergeTermTitle',
      'prReview.merge.confirmTitleTerm',
      'prReview.merge.enableAutoMergeConfirmMessageTerm',
      'prReview.merge.enableAutoMergeDescriptionTerm',
      'prReview.merge.providerBlocked.permission',
      'prReview.merge.providerBlocked.draft',
      'prReview.operation.mergeResultNotCompleted',
      'prReview.mutationError.reviewNotSubmittedTerm',
    ] as const;
    for (const platform of PLATFORMS) {
      const term = i18n.t(providerPrNounKey(platform));
      for (const key of KEYS) {
        const rendered = withTerm(key, platform);
        // `į` governs the accusative, so a nominative noun cannot follow it.
        // The trailing label sits in parentheses, which `[^()]*` never enters.
        expect(rendered, `${key} ${platform}`).not.toMatch(/į [^()]*užklausa/);
        expect(rendered.startsWith(term), `${key} ${platform}`).toBe(false);
      }
    }
  });
});

describe('Lithuanian review refusals', () => {
  it('names the review action and opens with one shared sentence', () => {
    const refusals = [
      i18n.t('prReview.mutationError.reviewNotSubmitted'),
      ...PLATFORMS.map(platform =>
        withTerm('prReview.mutationError.reviewNotSubmittedTerm', platform)
      ),
    ];
    for (const refusal of refusals) {
      expect(refusal).toContain('peržiūrėti');
      expect(refusal.startsWith('Šios peržiūros pateikti negalima.')).toBe(true);
    }
  });
});

describe('Lithuanian discussion access copy', () => {
  it('names the discussion in the accusative in both labels', () => {
    expect(i18n.t('prReview.terms.discussionAccessDenied').endsWith('diskusiją.')).toBe(true);
    expect(i18n.t('prReview.discussion.accessDeniedMessage').endsWith('diskusiją.')).toBe(true);
  });
});
