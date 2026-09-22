import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';

import { i18n } from '@/i18n';
import { providerPrRefLabel, providerPrTriple } from '@/lib/pr-review/provider-pr-ref';
import { findFirstProviderPrUrl } from '@/lib/pr-review/provider-pr-url';

/**
 * Decide whether the share gate shows the Review PR destination. The option is
 * visible only when the feature flag is on, the gate would otherwise offer a
 * New session (not a stale-share / all-rejected terminal state), and the staged
 * text contains a parseable GitHub, GitLab or Bitbucket review URL. Parsing
 * routes through the one provider URL resolver, so a GitLab merge request and
 * a Bitbucket pull request are recognised exactly like a GitHub PR.
 */
export function selectShareReviewPr(input: {
  text: string;
  prReviewEnabled: boolean;
  showNewSession: boolean;
}): ProviderPrRef | null {
  if (!input.prReviewEnabled || !input.showNewSession) {
    return null;
  }
  return findFirstProviderPrUrl(input.text);
}

/**
 * The identity line under the Review PR row, written in the provider's own
 * reference syntax: GitLab numbers merge requests `group/sub/repo!12`, the
 * others write `owner/repo #12`. `share.reviewPrSubtitle` is format-only — the
 * same placeholder string in every locale — so the GitLab arm composes the
 * line from the shared provider label instead of adding a key all 86 catalogs
 * would have to carry.
 */
export function selectShareReviewPrSubtitle(ref: ProviderPrRef): string {
  if (ref.platform === 'gitlab') {
    return providerPrRefLabel(ref);
  }
  return i18n.t('share.reviewPrSubtitle', providerPrTriple(ref));
}
