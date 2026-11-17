import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPrMergeTitles } from '@/components/pr-review/merge/pr-merge-titles';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { i18n } from '@/i18n';
import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';

/**
 * The Lithuanian catalog used a second word for the same English "Open" in the
 * standalone open chip, so it did not read like the combined chips on the same
 * screen. The unavailable copy named an unspecified service, and the file
 * field named a field instead of the filter action.
 *
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
  /** Where the noun sits, and therefore the shape the sentence has to keep. */
  const SLOTS = [
    ['prReview.discussion.replyForbiddenTerm', 'label'],
    ['prReview.merge.enableAutoMergeConfirmMessageTerm', 'label'],
    ['prReview.merge.enableAutoMergeDescriptionTerm', 'label'],
    ['prReview.merge.providerBlocked.permission', 'label'],
    ['prReview.merge.providerBlocked.draft', 'label'],
    ['prReview.merge.mergeTermTitle', 'named-action'],
    ['prReview.merge.confirmTitleTerm', 'named-action-question'],
    ['prReview.operation.mergeResultNotCompleted', 'clause-subject'],
    ['prReview.mutationError.reviewNotSubmittedTerm', 'clause-subject'],
  ] as const;

  it('keeps the noun in the shape its slot can carry, on both platform nouns', () => {
    const shape = {
      label: (term: string) => `(${term})`,
      'named-action': (term: string) => `: ${term}`,
      'named-action-question': (term: string) => `: ${term}?`,
      'clause-subject': () => '',
    } as const;
    for (const platform of PLATFORMS) {
      const term = i18n.t(providerPrNounKey(platform));
      for (const [key, kind] of SLOTS) {
        const rendered = withTerm(key, platform);
        const labelled = `${key} ${platform}`;
        if (kind === 'label') {
          // Every occurrence of the noun sits inside its own label.
          expect(rendered.split(`(${term})`).length - 1, labelled).toBe(
            rendered.split(term).length - 1
          );
        } else if (kind === 'named-action-question') {
          expect(rendered.endsWith(shape['named-action-question'](term)), labelled).toBe(true);
        } else if (kind === 'named-action') {
          expect(rendered.endsWith(shape['named-action'](term)), labelled).toBe(true);
        } else if (key === 'prReview.operation.mergeResultNotCompleted') {
          // The object is the clause subject, so it follows a non-interpolated word.
          expect(rendered.startsWith(`Ši ${term} `), labelled).toBe(true);
        } else {
          // The refusal opens its second clause with an adverb, so the noun
          // follows the verb as that clause's subject and never starts the line.
          expect(rendered.startsWith(term), labelled).toBe(false);
          expect(rendered.includes(`pasikeitė ${term} `), labelled).toBe(true);
        }
        // No verb and no accusative preposition may take the noun directly:
        // `sujungti`, `sujungs`, `peržiūrėti` and `į` all require a declined
        // object, and the catalog stores one base form.
        expect(rendered, labelled).not.toMatch(
          new RegExp(`(?:sujungti|sujungs|peržiūrėti|į) ${term}`, 'i')
        );
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
