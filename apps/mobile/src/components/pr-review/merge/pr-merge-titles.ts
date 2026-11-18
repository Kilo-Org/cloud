// The merge action's wording on the provider arms.
//
// GitHub and Bitbucket call the object a pull request, and "Merge {{term}}"
// reads cleanly with that noun. GitLab calls it a merge request, so the same
// template repeats the word ("Merge merge request") — and a catalog's own verb
// or particle can land on an edge of the translated noun instead ("د د …",
// "… درخواست ادغام ادغام …"). The merge-request arm therefore names the
// action on its own and never interpolates the noun, so no catalog can
// reproduce the doubled word.
//
// The merge-request arm words its action as a bare verb, which is right on the
// button and wrong as the heading above a form. The heading therefore takes the
// merge noun the section label already uses, so the button can read as a verb
// while the heading reads as a noun.
//
// Standalone (no React imports) so the merge sheet, the merge screen, the
// section button and the review-copy fixture share one mapping.

import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';
import { type TFunction } from 'i18next';

import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';

type ProviderPrMergeTitles = Readonly<{
  /** The merge action, for the section button's accessibility label. */
  readonly action: string;
  /** The merge sheet's heading, above the form. */
  readonly title: string;
  /** The confirmation the merge sheet opens before it submits. */
  readonly confirm: string;
}>;

export function providerPrMergeTitles(
  t: TFunction,
  platform: ProviderPrPlatform
): ProviderPrMergeTitles {
  if (platform === 'gitlab') {
    return {
      action: t('prReview.merge.merge'),
      title: t('prReview.merge.mergeTitle'),
      confirm: t('prReview.merge.confirmMergeTitle'),
    };
  }
  if (platform === 'github') {
    const action = t('prReview.merge.mergePullRequest');
    return {
      action,
      title: action,
      confirm: t('prReview.merge.confirmTitle'),
    };
  }
  const term = t(providerPrNounKey(platform));
  const action = t('prReview.merge.mergeTermTitle', { term });
  return {
    action,
    title: action,
    confirm: t('prReview.merge.confirmTitleTerm', { term }),
  };
}
